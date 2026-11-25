import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { locate } from "../dist/resources.js";
import { change } from "../dist/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "asc-acceptance-"));
const directory = path.join(root, "checkout");
const scenario = process.env.ASC_SCENARIO ?? "patch";
// Mirrors the README install: one global plugin entry in managed mode, nothing project-local.
const globalManaged = process.env.ASC_INSTALL === "global-managed";
const joinScenario = scenario.startsWith("join");
let apiURL;
await mkdir(directory);
const vetoPlugin = path.join(root, "veto");
if (scenario === "rollback" || scenario === "ambiguous-deny") {
  await mkdir(vetoPlugin);
  await writeFile(
    path.join(vetoPlugin, "index.ts"),
    `import {appendFileSync} from "node:fs";
    export default {id:"fixture-veto",async setup(ctx){
    await ctx.permission.hook("evaluate",e=>{if(e.resources.includes("denied.txt")) {e.effect="deny"; e.message="Fixture denied the edit."}});
    await ctx.tool.hook("execute.after",e=>appendFileSync(${JSON.stringify(path.join(root, "after-events"))},JSON.stringify({tool:e.tool,status:e.status})+"\\n"));
  }}`,
  );
}
if (scenario === "nested") {
  execFileSync("git", ["init", "--quiet", directory]);
  await mkdir(path.join(directory, "module"));
}
if (process.env.ASC_TRACE) {
  const probe = path.join(directory, ".opencode/plugins/probe");
  await mkdir(probe, { recursive: true });
  await writeFile(
    path.join(probe, "index.ts"),
    `import {appendFileSync} from 'node:fs';
export default {id:'fixture-probe',async setup(ctx){
const c=new AbortController(); void(async()=>{for await(const e of ctx.event.subscribe({types:['session.status','session.idle'],signal:c.signal})) appendFileSync(${JSON.stringify(path.join(root, "trace"))},JSON.stringify([e.type,e.data])+'\\n')})().catch(e=>appendFileSync(${JSON.stringify(path.join(root, "trace"))},String(e)+'\\n'));
await ctx.permission.hook('evaluate',e=>appendFileSync(${JSON.stringify(path.join(root, "trace"))},JSON.stringify([e.action,e.resources,e.source,Object.keys(e.metadata??{})])+'\\n'));
return ()=>c.abort()
}}`,
  );
}
await writeFile(path.join(directory, "shared.txt"), "original\n");
if (scenario === "failed-build" || scenario === "lost-grant")
  await writeFile(path.join(directory, "gradlew"), "#!/bin/sh\necho invoked >> builds\nexit 3\n", { mode: 0o755 });
if (scenario === "build" || scenario === "veto")
  await writeFile(
    path.join(directory, "gradlew"),
    `#!/bin/sh
echo invoked >> builds
while [ ! -f finish ]; do sleep 0.1; done
`,
    { mode: 0o755 },
  );
const plugin = process.env.ASC_PACKAGE ?? fileURLToPath(new URL("../", import.meta.url));
const children = new Set();
const redisPort = globalManaged
  ? 6390
  : Number(new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379").port || 6379);
async function snapshot() {
  const client = new Redis(redisPort, "127.0.0.1");
  try {
    return (
      await change(client, (await locate(directory)).project, "who", {
        id: "fixture",
        token: "unused",
        label: "Fixture",
      })
    ).sessions;
  } finally {
    client.disconnect();
  }
}
let online = true;
let dropStage = scenario === "ambiguous-deny";
let droppedStage = false;
let droppedPending;
const connections = new Set();
const proxy = net.createServer((client) => {
  if (!online) {
    client.destroy();
    return;
  }
  const upstream = net.connect(redisPort, "127.0.0.1");
  connections.add(client);
  client.on("error", () => client.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => {
    connections.delete(client);
    upstream.destroy();
  });
  upstream.on("close", () => client.destroy());
  let discard = false;
  client.on("data", (data) => {
    if (dropStage && data.includes(Buffer.from("\r\nstage\r\n"))) {
      dropStage = false;
      discard = true;
    }
    upstream.write(data);
  });
  upstream.on("data", async (data) => {
    if (discard) {
      const observer = new Redis(redisPort, "127.0.0.1");
      try {
        droppedPending = Object.values(await observer.hgetall((await locate(directory)).project)).map(
          (row) => JSON.parse(row).pending,
        );
      } finally {
        observer.disconnect();
      }
      droppedStage = true;
      client.destroy();
    } else client.write(data);
  });
});
if (["recover", "ambiguous-deny"].includes(scenario))
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const errors = [];
let releaseOwner;
const hold = new Promise((resolve) => {
  releaseOwner = resolve;
});
const calls = new Map();
const observed = [];
let peerAdmitted;
const admitted = new Promise((resolve) => {
  peerAdmitted = resolve;
});
const server = http.createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    const text = JSON.stringify(message.messages ?? []);
    const actor = message.messages.some(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("OWNER_CASE"),
    )
      ? "owner"
      : "peer";
    const step = (calls.get(actor) ?? 0) + 1;
    calls.set(actor, step);
    const names = (message.tools ?? []).map((t) => t.function.name);
    observed.push({ actor, step, names });
    let call;
    const patch = (file, content) => `*** Begin Patch\n*** Add File: ${file}\n+${content}\n*** End Patch`;
    if (scenario === "ambiguous-deny" && step === 1) {
      call = ["patch", { patchText: patch("denied.txt", "wrong") }];
    } else if (scenario === "ambiguous-deny" && step === 2) {
      assert.ok(droppedStage, "The proxy did not discard the stage response");
      assert.ok(
        droppedPending.some((pending) => Object.keys(pending).length > 0),
        JSON.stringify(droppedPending),
      );
      assert.match(text, /Fixture denied/);
      await delay(2300);
      call = ["coord_who", {}];
    } else if (scenario === "ambiguous-deny") {
      await hold;
    } else if (scenario === "lost-grant" && step === 1) {
      call = ["coord_exclusive", { mode: "stable-build", reason: "Final verification" }];
    } else if (scenario === "lost-grant" && step === 2) {
      assert.ok((await snapshot()).some((participant) => participant.policy?.phase === "exclusive"));
      const client = new Redis(redisPort, "127.0.0.1");
      try {
        await client.del((await locate(directory)).project);
      } finally {
        client.disconnect();
      }
      call = ["shell", { command: "./gradlew test", timeout: 30000 }];
    } else if (scenario === "lost-grant") {
      assert.match(text, /protection.*lost/i);
    } else if (scenario === "veto" && actor === "owner" && step === 2) {
      await admitted;
      call = ["coord_exclusive", { mode: "stable-build", reason: "Final verification" }];
    } else if (scenario === "veto" && actor === "owner" && step === 3) {
      call = ["shell", { command: "./gradlew test", timeout: 30000 }];
    } else if (scenario === "veto" && actor === "owner" && step === 4) {
      await hold;
    } else if (scenario === "veto" && actor === "peer" && step === 1) {
      assert.ok(names.includes("patch"));
      peerAdmitted();
      for (
        let i = 0;
        i < 100 &&
        !(await readFile(path.join(directory, "builds")).then(
          () => true,
          () => false,
        ));
        i++
      )
        await delay(100);
      assert.equal((await snapshot()).find((p) => p.policy)?.policy.phase, "exclusive");
      call = ["patch", { patchText: patch("during-build.txt", "wrong") }];
    } else if (scenario === "veto" && actor === "peer" && step === 2) {
      assert.ok(!names.includes("patch") && !names.includes("shell") && names.includes("read"));
      call = ["read", { path: "shared.txt" }];
    } else if (scenario === "veto" && actor === "peer" && step === 3) {
      await writeFile(path.join(directory, "finish"), "");
    } else if (scenario === "recover" && actor === "peer" && step === 1) {
      call = ["patch", { patchText: patch("offline.txt", "written") }];
    } else if (scenario === "recover" && actor === "peer" && step === 2) {
      online = true;
      await delay(2300);
      assert.ok(
        (await snapshot()).some((p) => p.paths.some((x) => x.startsWith("file:shared.txt"))),
        "Owner no longer holds its live claim before recovery",
      );
      call = [
        "patch",
        { patchText: "*** Begin Patch\n*** Update File: shared.txt\n@@\n-owner\n+stolen\n*** End Patch" },
      ];
    } else if (["build", "failed-build"].includes(scenario) && step === 1) {
      call = ["shell", { command: "./gradlew test", timeout: 30000 }];
    } else if (scenario === "build" && actor === "owner") {
      // The shell command itself keeps this session busy.
    } else if (scenario === "outage" && step === 1) {
      call = ["coord_who", {}];
    } else if ((scenario === "deny" && step === 1) || (scenario === "outage" && step === 2)) {
      call = ["patch", { patchText: patch("offline.txt", "written") }];
    } else if (joinScenario && actor === "peer" && step > 1) {
      if (step === 2 && scenario !== "join-parallel") call = ["coord_wait", {}];
      else if (step === (scenario === "join-parallel" ? 2 : 3))
        call = ["patch", { patchText: patch("resumed.txt", "resumed") }];
    } else if (["outage", "deny"].includes(scenario) || (joinScenario && actor === "peer")) {
      if (joinScenario) {
        if (scenario !== "join-default-wait") {
          assert.equal(names.includes("patch"), false, "Waiting session retained edit tools");
          assert.match(text, /coord-parallel/);
        }
      }
    } else if (scenario === "join-default-wait" && actor === "owner" && step === 1) {
      call = ["coord_who", {}];
    } else if (step === 1 && actor === "owner") {
      call = [
        "patch",
        { patchText: "*** Begin Patch\n*** Update File: shared.txt\n@@\n-original\n+owner\n*** End Patch" },
      ];
    } else if (scenario === "rollback" && actor === "owner" && step === 2) {
      call = ["patch", { patchText: patch("denied.txt", "should not exist") }];
    } else if (actor === "owner" && (step === 2 || (scenario === "rollback" && step === 3))) {
      await hold;
    } else if (actor === "peer" && step === 1) {
      const source = scenario === "nested" ? "../shared.txt" : "shared.txt";
      const extra = scenario === "mixed" ? "*** Add File: ../external.txt\n+outside\n" : "";
      call = [
        "patch",
        {
          patchText: `*** Begin Patch\n${extra}*** Add File: partial.txt\n+unexpected\n*** Update File: ${source}\n*** Move to: moved.txt\n@@\n-owner\n+stolen\n*** End Patch`,
        },
      ];
    } else if (actor === "peer" && step === 2) {
      call = ["patch", { patchText: patch("independent.txt", "ok") }];
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: `mock-${actor}-${step}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "local",
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    if (call) {
      if (!names.includes(call[0])) throw new Error(`Expected ${call[0]}; available: ${names.join(",")}`);
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_${step}`,
            type: "function",
            function: {
              name: call[0],
              arguments: JSON.stringify(call[1]),
            },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: "Finished." });
      chunk({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  } catch (error) {
    errors.push(String(error));
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = {
  PATH: process.env.PATH,
  HOME: root,
  XDG_CONFIG_HOME: `${root}/config`,
  XDG_DATA_HOME: `${root}/data`,
  XDG_CACHE_HOME: `${root}/cache`,
  XDG_STATE_HOME: `${root}/state`,
  ASC_LOCAL_KEY: "offline-test",
  OPENCODE_PASSWORD: randomUUID(),
};
const port = ["recover", "ambiguous-deny"].includes(scenario) ? proxy.address().port : redisPort;
// A closed port is not a safe outage fixture: another test can bind one. This server accepts and resets.
const refusing = net.createServer((socket) => socket.destroy());
if (["outage", "deny"].includes(scenario))
  await new Promise((resolve) => refusing.listen(0, "127.0.0.1", resolve));
const offlinePort = refusing.listening ? refusing.address().port : 0;
const containersBefore = globalManaged
  ? ""
  : execFileSync("docker", ["ps", "-aq", "--filter", "name=agents-shared-context-"], { encoding: "utf8" }).trim();
const joinMode = joinScenario && scenario !== "join-default-wait" ? "ask" : "parallel";
const extras = ["rollback", "ambiguous-deny"].includes(scenario) ? [vetoPlugin] : [];
// Mirrors the README install: one global plugin entry in managed mode, nothing project-local.
const pluginEntry = { package: plugin, options: { managed: globalManaged, join: joinMode } };
if (!globalManaged) {
  pluginEntry.options.port = offlinePort || port;
  pluginEntry.options.leaseSeconds = scenario === "build" ? 10 : 600;
}
if (globalManaged) {
  await mkdir(path.join(root, "config/opencode"), { recursive: true });
  await writeFile(path.join(root, "config/opencode/opencode.json"), JSON.stringify({ plugins: [pluginEntry] }));
}
const projectPlugins = globalManaged ? extras : [pluginEntry, ...extras];
await writeFile(
  path.join(directory, "opencode.json"),
  JSON.stringify({
    plugins: projectPlugins,
    ...(scenario === "deny" ? { permissions: [{ action: "edit", resource: "offline.txt", effect: "deny" }] } : {}),
    providers: {
      openai: {
        env: ["ASC_LOCAL_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1` },
        models: { "gpt-5-fixture": { capabilities: { tools: true }, limit: { context: 64000, output: 1024 } } },
      },
    },
    model: "openai/gpt-5-fixture",
  }),
);
function run(prompt, api) {
  const child = spawn(
    "opencode",
    [
      "run",
      ...(api ? ["--server", api] : ["--standalone"]),
      "--auto",
      "--format",
      "json",
      "--title",
      prompt,
      "-m",
      "openai/gpt-5-fixture",
      prompt,
    ],
    {
      cwd: scenario === "nested" && prompt === "PEER_CASE" ? path.join(directory, "module") : directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  let output = "";
  child.stdout.on("data", (x) => {
    output += x;
  });
  child.stderr.on("data", (x) => {
    output += x;
  });
  const done = once(child, "exit").then(([code]) => {
    children.delete(child);
    return { code, output };
  });
  return { child, done, output: () => output };
}
try {
  const owner = run("OWNER_CASE");
  if (scenario === "ambiguous-deny") {
    for (let i = 0; i < 200 && (calls.get("owner") ?? 0) < 3 && !errors.length; i++) await delay(50);
    assert.equal(errors.length, 0, errors.join(";"));
    assert.ok((calls.get("owner") ?? 0) >= 3, owner.output());
    await assert.rejects(readFile(path.join(directory, "denied.txt")), { code: "ENOENT" });
    const events = await readFile(path.join(root, "after-events"), "utf8").catch(() => "");
    const after = events
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const client = new Redis(redisPort, "127.0.0.1");
    let records;
    try {
      records = Object.values(await client.hgetall((await locate(directory)).project)).map((row) =>
        JSON.parse(row),
      );
    } finally {
      client.disconnect();
    }
    console.log(
      `Denial lifecycle: after=${JSON.stringify(after)} pending=${JSON.stringify(records.map((r) => r.pending))}`,
    );
    assert.ok(
      after.some((event) => event.tool === "patch" && event.status === "error"),
      "No after callback for denied patch",
    );
    assert.ok(
      records.every((record) => Object.keys(record.pending).length === 0),
      "Denied call left a pending stage",
    );
    releaseOwner();
    assert.equal((await owner.done).code, 0);
    console.log("PASS: denied ambiguous edit triggered error callback and was settled.");
  } else if (["outage", "deny", "lost-grant"].includes(scenario)) {
    const result = await Promise.race([owner.done, delay(40000, null, { ref: false })]);
    assert.ok(result, "Offline edit timed out");
    if (scenario === "lost-grant") {
      assert.equal(result.code, 0, result.output);
      assert.equal(errors.length, 0, errors.join(";"));
      assert.match(result.output, /protection.*lost/i);
      await assert.rejects(readFile(path.join(directory, "builds")), { code: "ENOENT" });
      console.log("PASS: lost stable-source grant refused the build before shell launch.");
    } else if (scenario === "deny") {
      await assert.rejects(readFile(path.join(directory, "offline.txt")), { code: "ENOENT" });
      assert.match(result.output, /denied|deny/i);
      console.log("PASS: native permission denial still prevents the edit during a Redis outage.");
    } else {
      const calls = result.output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((e) => e.type === "tool_use");
      for (const name of ["coord_who", "patch"])
        assert.match(calls.find((e) => e.part.tool === name).part.state.output, /Shared context unavailable/);
      assert.equal(await readFile(path.join(directory, "offline.txt"), "utf8"), "written\n");
      console.log("PASS: Redis unavailable; native patch applied with a model-facing tool warning.");
    }
  } else {
    for (let n = 0; n < 400; n++) {
      const ownerSteps = scenario === "rollback" ? 3 : 2;
      const ownerBusy =
        scenario === "build"
          ? await readFile(path.join(directory, "builds")).then(
              () => true,
              () => false,
            )
          : (calls.get("owner") ?? 0) >= ownerSteps;
      if (ownerBusy) break;
      if (owner.child.exitCode !== null || errors.length) break;
      await delay(100);
    }
    if (!["build", "failed-build", "join-default-wait"].includes(scenario))
      assert.equal(
        await readFile(path.join(directory, "shared.txt"), "utf8"),
        "owner\n",
        `Owner failed: ${errors.join(";")} ${owner.output()}`,
      );
    if (scenario === "build") await delay(11000);
    if (scenario === "rollback") {
      await assert.rejects(readFile(path.join(directory, "denied.txt")), { code: "ENOENT" });
      assert.match(owner.output(), /Fixture denied/);
      assert.deepEqual(
        (await snapshot()).flatMap((s) =>
          s.paths.map((p) => p.slice(0, p.lastIndexOf("@") === -1 ? undefined : p.lastIndexOf("@"))),
        ),
        ["file:shared.txt"],
      );
    }
    if (scenario === "recover") {
      const before = await snapshot();
      assert.ok(
        before.some((p) => p.paths.some((x) => x.startsWith("file:shared.txt"))),
        `Owner holds no live claim before the outage. Participants: ${JSON.stringify(before)}. ` +
          `First tool results: ${(owner.output().match(/"output":"[^"]{0,160}/g) ?? []).join(" | ")}`,
      );
      online = false;
      for (const client of connections) client.destroy();
    }
    if (scenario === "join-default-wait") {
      assert.ok((await snapshot()).some((p) => p.state === "active" && p.paths.length === 0));
    }
    if (joinScenario) {
      const socket = http.createServer();
      await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
      const apiPort = socket.address().port;
      await new Promise((resolve) => socket.close(resolve));
      apiURL = `http://127.0.0.1:${apiPort}`;
      const service = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(apiPort)], {
        env,
        cwd: directory,
        stdio: "ignore",
      });
      children.add(service);
      let ready = false,
        status;
      for (let i = 0; i < 100 && !ready; i++) {
        ready = await fetch(`${apiURL}/api/info`).then(
          (r) => {
            status = r.status;
            return true;
          },
          () => false,
        );
        if (!ready) await delay(100);
      }
      assert.ok(ready, `Isolated server did not start (exit ${service.exitCode}, HTTP ${status})`);
    }
    const peer = run("PEER_CASE", apiURL);
    const result = await Promise.race([peer.done, delay(45000, null, { ref: false })]);
    assert.ok(result, `Peer timed out: ${errors.join(";")} ${peer.output()}`);
    assert.equal(result.code, 0, result.output);
    if (scenario === "veto") {
      assert.equal(errors.length, 0, errors.join(";"));
      assert.match(result.output, /Read-only:.*Final verification/);
      await assert.rejects(readFile(path.join(directory, "during-build.txt")), { code: "ENOENT" });
      for (let i = 0; i < 100 && (calls.get("owner") ?? 0) < 4; i++) await delay(50);
      assert.ok((await snapshot()).every((p) => !p.policy && !p.paths.includes("build:checkout")));
      console.log(
        "PASS: already-admitted parallel peer denied a stale patch during stable build, allowed to read; sharing resumed at build exit.",
      );
    } else if (scenario === "failed-build") {
      assert.equal(await readFile(path.join(directory, "builds"), "utf8"), "invoked\ninvoked\n");
      assert.ok((await snapshot()).every((s) => !s.paths.includes("build:checkout")));
      console.log("PASS: a failed build freed its reservation while the owner session remained busy.");
    } else if (scenario === "build") {
      assert.equal(await readFile(path.join(directory, "builds"), "utf8"), "invoked\n", result.output);
      assert.match(result.output, /conflict/i);
      await writeFile(path.join(directory, "finish"), "");
      console.log("PASS: two foreground build requests; only one underlying process started.");
    } else if (scenario === "recover") {
      assert.match(result.output, /Shared context unavailable/);
      assert.match(result.output, /Conflict: shared\.txt is held by OWNER_CASE \([A-Za-z0-9]{6}\)\./);
      assert.equal(await readFile(path.join(directory, "offline.txt"), "utf8"), "written\n");
      assert.equal(await readFile(path.join(directory, "shared.txt"), "utf8"), "owner\n");
      console.log("PASS: offline edit continued; after reconnection the next conflicting patch was denied.");
    } else if (joinScenario) {
      assert.equal(errors.length, 0, errors.join(";"));
      assert.ok((calls.get("peer") ?? 0) >= 1);
      const session = result.output
        .split("\n")
        .flatMap((line) => {
          try {
            return [JSON.parse(line).sessionID];
          } catch {
            return [];
          }
        })
        .find(Boolean);
      assert.ok(session, result.output);
      const mode = scenario === "join-parallel" ? "parallel" : "wait";
      const route = `/api/session/${session}/command`;
      execFileSync(
        "opencode",
        ["api", "--server", apiURL, "post", route, "-d", JSON.stringify({ name: `coord-${mode}`, text: "" })],
        { env, cwd: directory },
      );
      if (mode === "wait") {
        for (let i = 0; i < 100 && (calls.get("peer") ?? 0) < 2; i++) await delay(100);
        assert.equal(calls.get("peer"), 2, "Wait command did not enter the wait step");
        await assert.rejects(readFile(path.join(directory, "resumed.txt")), { code: "ENOENT" });
        if (scenario === "join-default-wait") {
          let messages = "";
          let running = false;
          let progress = false;
          for (let i = 0; i < 50; i++) {
            messages = execFileSync(
              "opencode",
              ["api", "--server", apiURL, "get", `/api/session/${session}/message`],
              { env, cwd: directory, encoding: "utf8" },
            );
            const data = JSON.parse(messages).data;
            const part = data
              .flatMap((message) => message.content ?? [])
              .find(
                (item) => item.type === "tool" && item.name === "coord_wait" && item.state?.status === "running",
              );
            running ||= !!part;
            progress ||= /Waiting for session .*Stop the tool to cancel/.test(part?.state?.metadata?.title ?? "");
            if (running && (process.env.ASC_REQUIRE_PROGRESS !== "1" || progress)) break;
            await delay(100);
          }
          assert.ok(running, `Running coord_wait was not observed: ${messages}`);
          if (process.env.ASC_REQUIRE_PROGRESS === "1") {
            assert.ok(progress, "Running coord_wait did not expose progress metadata");
            console.log("PASS: isolated server session messages expose the active wait progress metadata.");
          } else {
            console.log("PASS: isolated server exposes the running wait; progress rendering is not required.");
          }
        }
        if (scenario === "join-cancel") {
          execFileSync(
            "opencode",
            ["api", "--server", apiURL, "post", `/api/session/${session}/interrupt`, "-d", '{"resume":false}'],
            { env, cwd: directory },
          );
          let remaining;
          for (let i = 0; i < 60; i++) {
            remaining = (await snapshot()).some((s) => s.id === session);
            if (!remaining) break;
            await delay(100);
          }
          const state = JSON.parse(
            execFileSync("opencode", ["api", "--server", apiURL, "get", `/api/session/${session}`], {
              env,
              cwd: directory,
              encoding: "utf8",
            }),
          );
          assert.equal(
            remaining,
            false,
            JSON.stringify({
              participants: await snapshot(),
              time: (state.data ?? state).time,
              outcome: (state.data ?? state).outcome,
            }),
          );
        }
        releaseOwner();
      }
      if (scenario === "join-cancel") {
        await assert.rejects(readFile(path.join(directory, "resumed.txt")), { code: "ENOENT" });
        console.log("PASS: cancelled wait released membership without editing or disturbing the active owner.");
      } else {
        let resumed;
        for (let i = 0; i < 150 && !resumed; i++) {
          resumed = await readFile(path.join(directory, "resumed.txt"), "utf8").catch(() => undefined);
          if (!resumed) await delay(100);
        }
        assert.equal(resumed, "resumed\n", JSON.stringify({ errors, observed }));
        console.log(`PASS: joining session paused before edits; /coord-${mode} resumed the original session.`);
      }
    } else {
      assert.equal(await readFile(path.join(directory, "shared.txt"), "utf8"), "owner\n");
      const peerDir = scenario === "nested" ? path.join(directory, "module") : directory;
      await assert.rejects(readFile(path.join(root, "external.txt")), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(peerDir, "partial.txt")), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(peerDir, "moved.txt")), { code: "ENOENT" });
      assert.equal(await readFile(path.join(peerDir, "independent.txt"), "utf8"), "ok\n");
      assert.match(result.output, /conflict/i);
      console.log(
        `PASS (${scenario}): owner edit retained, competing rename rejected atomically, independent file created.`,
      );
    }
    releaseOwner();
    assert.equal((await owner.done).code, 0);
  }
  if (globalManaged) {
    const container = "agents-shared-context-6390";
    const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
    assert.equal(docker("port", container, "6379"), "127.0.0.1:6390");
    assert.equal(
      docker("inspect", "-f", '{{ index .Config.Labels "io.github.sutulovai.agents-shared-context" }}', container),
      "1",
    );
    console.log("PASS: global managed install started one labelled loopback-only Redis container on 6390.");
  } else {
    // An unmanaged run must never create the managed container: a wrong option would otherwise look like an outage.
    const managedContainers = () =>
      execFileSync("docker", ["ps", "-aq", "--filter", "name=agents-shared-context-"], {
        encoding: "utf8",
      }).trim();
    assert.deepEqual(managedContainers(), containersBefore, "An unmanaged run created a managed Redis container");
  }
} finally {
  releaseOwner();
  for (const child of children) child.kill();
  server.closeAllConnections();
  server.close();
  if (proxy.listening) proxy.close();
  if (refusing.listening) refusing.close();
  for (const client of connections) client.destroy();
  if (errors.length) console.error(errors, observed);
  if (process.env.ASC_TRACE)
    console.log(await readFile(path.join(root, "trace"), "utf8").catch(() => "No permission trace"));
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
