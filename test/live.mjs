// Live-model check: drives real OpenCode sessions through the user's configured provider.
// Not part of the default suite. Requires ASC_LIVE_MODEL, REDIS_URL and a plugin build or ASC_PACKAGE.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { locate } from "../dist/resources.js";
import { change } from "../dist/store.js";

execFileSync(process.execPath, [fileURLToPath(new URL("./require-redis.mjs", import.meta.url))], {
  stdio: "inherit",
});

const model = process.env.ASC_LIVE_MODEL;
const scenario = process.env.ASC_SCENARIO;
assert.ok(
  model && ["gate", "conflict", "stable-build", "blocking-claim"].includes(scenario),
  "Set ASC_LIVE_MODEL and a known ASC_SCENARIO",
);
const plugin = process.env.ASC_PACKAGE ?? fileURLToPath(new URL("../", import.meta.url));
const redisPort = Number(new URL(process.env.REDIS_URL).port || 6379);
const root = await mkdtemp(path.join(os.tmpdir(), `asc-live-${scenario}-`));
const directory = path.join(root, "project");
const join = scenario === "gate" ? "ask" : "parallel";
const children = new Set();
const sessions = new Set();
const all = [];
// The gate peer answers at once, the conflict peer must outwait the owner, the build needs a long-running neighbour.
const steps = { gate: 120, conflict: 40, "stable-build": 200, "blocking-claim": 40 }[scenario];

await mkdir(directory);
execFileSync("git", ["init", "--quiet", directory]);
if (scenario === "stable-build") await writeFile(path.join(directory, "loop.txt"), "start\n");
else await writeFile(path.join(directory, "shared.txt"), "start\n");
if (scenario === "stable-build") {
  await writeFile(path.join(directory, "gradlew"), "#!/bin/sh\necho invoked >> builds.log\nsleep 8\n", {
    mode: 0o755,
  });
}
if (process.env.ASC_TRACE) {
  // Loaded after the plugin under test, so it observes the tools each model request really receives.
  const probe = path.join(root, "trace-plugin");
  await mkdir(probe);
  await writeFile(
    path.join(probe, "index.ts"),
    `import { appendFileSync } from "node:fs";
export default { id: "live-trace", async setup(ctx) {
  await ctx.session.hook("context", (e) => appendFileSync(${JSON.stringify(path.join(root, "trace.log"))},
    "CONTEXT " + e.sessionID.slice(-6) + " " + Object.keys(e.tools).sort().join(",") + "\\n"));
  await ctx.tool.hook("execute.before", (e) => appendFileSync(${JSON.stringify(path.join(root, "trace.log"))},
    "BEFORE " + e.sessionID.slice(-6) + " " + e.tool + "\\n"));
} };`,
  );
}
await writeFile(
  path.join(directory, "opencode.json"),
  JSON.stringify({
    plugins: [
      { package: plugin, options: { managed: false, port: redisPort, join } },
      ...(process.env.ASC_TRACE ? [path.join(root, "trace-plugin")] : []),
    ],
  }),
);

async function snapshot() {
  const client = new Redis(redisPort, "127.0.0.1");
  try {
    const owner = { id: "fixture", token: "unused", label: "Fixture" };
    return (await change(client, (await locate(directory)).project, "who", owner)).sessions;
  } finally {
    client.disconnect();
  }
}
async function until(check, ms, message) {
  for (const end = Date.now() + ms; ; ) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new assert.AssertionError({ message });
    await delay(250);
  }
}
const lines = async (file) =>
  readFile(path.join(directory, file), "utf8")
    .then((t) => t.split("\n").filter(Boolean))
    .catch(() => []);

function run(title, prompt) {
  const child = spawn(
    "opencode",
    ["run", "--auto", "--archived", "--format", "json", "-m", model, "--title", `ASC live test: ${title}`, prompt],
    // `opencode run` takes the session directory from $PWD, not from the process working directory.
    // Strip this session's OPENCODE*/CMUX* context too, or nested runs attach to our own session.
    {
      cwd: directory,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPENCODE|CMUX)/.test(k))),
        PWD: directory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  const state = { title, events: [], output: "" };
  all.push(state);
  child.stdout.on("data", (x) => {
    state.output += x;
    for (const line of x.toString().split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.sessionID) sessions.add(event.sessionID);
        state.events.push(event);
      } catch {}
    }
  });
  child.stderr.on("data", (x) => (state.output += x));
  const done = once(child, "exit").then(([code]) => {
    children.delete(child);
    return { code, ...state };
  });
  return { state, done, child };
}
const toolCalls = (state) =>
  state.events
    .filter((e) => e.type === "tool_use")
    .map((e) => ({
      tool: e.part.tool,
      status: e.part.state.status,
      output: e.part.state.output ?? e.part.state.error ?? "",
    }));
const edits = (state) => toolCalls(state).filter((c) => c.tool === "edit");
const say = (text) =>
  (
    text.match(
      /.{0,300}(coord-\w+|Conflict:[^\n"]{0,120}|Read-only:[^\n"]{0,160}|exclusive[^\n"]{0,120}).{0,120}/gi,
    ) ?? []
  ).slice(0, 6);

const loop = (file, tag) =>
  `This is an automated coordination test. Append the line "${tag} step N" to ${file} for N = 1..${steps}, ` +
  `using the edit tool with exactly one separate edit call per line. Do not use shell, do not batch lines, ` +
  `do not ask questions. If an edit fails for another reason, fix your call and continue. Stop only when an ` +
  `error contains "Conflict" or "Read-only", and then report that exact error text.`;
const noQuestions = "Do not ask questions; this run has no person to answer.";
const transcript = () =>
  all
    .map((s) => s.events)
    .flat()
    .sort((x, y) => x.timestamp - y.timestamp)
    .flatMap((e) =>
      e.type === "text"
        ? [`TEXT ${e.sessionID.slice(-6)}: ${e.part.text.slice(0, 260)}`]
        : e.type === "tool_use"
          ? [
              `TOOL ${e.sessionID.slice(-6)} ${e.part.tool} [${e.part.state.status}]: ${String(e.part.state.output ?? e.part.state.error ?? "").slice(0, 260)}`,
            ]
          : [],
    )
    .join("\n");

try {
  const ownerPrompt =
    scenario === "blocking-claim"
      ? `This is an automated coordination test. First reserve shared.txt for yourself by calling coord_claim once ` +
        `with the input {"paths":["shared.txt"]}. Then append the line "owner step N" to shared.txt for N = 1..${steps}, ` +
        `using the edit tool with exactly one separate edit call per line. Do not use shell, do not batch lines, ` +
        `do not ask questions. If an edit fails, fix your call and continue. Stop only when an error contains ` +
        `"Conflict" or "Read-only", and then report that exact error text.`
      : loop(scenario === "stable-build" ? "loop.txt" : "shared.txt", "owner");
  const owner = run("owner loop", ownerPrompt);
  await until(
    async () => (await lines(scenario === "stable-build" ? "loop.txt" : "shared.txt")).length >= 3,
    240000,
    "Owner never started editing",
  ).catch(async (error) => {
    console.error("Owner output:", owner.state.output.slice(-2500));
    throw error;
  });

  let result,
    extra = {};
  if (scenario === "gate") {
    const peer = run(
      "joining session",
      `Append the line "peer" to shared.txt, then create other.txt containing "peer ok". This is an interactive session with a person at the terminal.`,
    );
    result = await Promise.race([peer.done, delay(300000, null, { ref: false })]);
    assert.ok(result, "Joining session timed out");
    extra = {
      peerNotices: say(
        result.events
          .filter((e) => e.type === "text")
          .map((e) => e.part.text)
          .join(" "),
      ),
    };
    const transcript = [
      ...result.events.filter((e) => e.type === "text").map((e) => `TEXT: ${e.part.text}`),
      ...toolCalls(result).map((c) => `TOOL ${c.tool} [${c.status}]: ${String(c.output).slice(0, 400)}`),
    ].join("\n");
    assert.equal(
      edits(result).length,
      0,
      `Joining session edited before the user chose: ${JSON.stringify(edits(result))}`,
    );
    assert.ok(
      /coord-(wait|parallel)/.test(result.output),
      `Joining session did not present the wait/parallel choice\n${transcript.slice(0, 3000)}`,
    );
    assert.ok(!(await lines("shared.txt")).includes("peer"));
    assert.deepEqual(await lines("other.txt"), []);
  } else if (scenario === "conflict") {
    const peer = run(
      "parallel session",
      `Make two separate edit calls in this order: first append the line "peer" to shared.txt; then create other.txt containing "peer ok". ` +
        `If the file is held by another session, wait for it rather than overriding it. ${noQuestions}`,
    );
    result = await Promise.race([peer.done, delay(300000, null, { ref: false })]);
    assert.ok(result, "Parallel session timed out");
    const hits = (state, pattern) =>
      state.events.filter((e) => e.type === "tool_use" && pattern.test(String(e.part.state.output ?? "")));
    const why = JSON.stringify({
      peerTools: toolCalls(result).map((c) => `${c.tool}[${c.status}]:${String(c.output).slice(0, 90)}`),
    });
    // The live model may avoid the conflict by checking first; what must hold is that its write landed after the owner's last one.
    const peerWrite = hits(result, /shared\.txt/).at(-1);
    const ownerWrite = owner.state.events.filter((e) => e.type === "tool_use" && e.part.tool === "edit").at(-1);
    assert.ok(
      peerWrite && peerWrite.timestamp > ownerWrite.timestamp,
      `Peer wrote the held file too early\n${why}`,
    );
    assert.deepEqual(await lines("other.txt"), ["peer ok"]);
    const shared = await lines("shared.txt");
    assert.equal(shared.at(-1), "peer");
    assert.equal(shared.filter((l) => l.startsWith("owner step ")).length, steps, "Owner lines were lost");
    extra = {
      peerConflicts: (result.output.match(/Conflict: file:shared\.txt/g) ?? []).length,
      peerWaits: toolCalls(result).filter((c) => c.tool === "coord_wait").length,
      peerTools: [...new Set(toolCalls(result).map((c) => c.tool))],
    };
  } else if (scenario === "blocking-claim") {
    const peer = run(
      "waiting claim",
      `Another session is editing shared.txt. Reserve it for yourself by calling coord_claim once with the input {"paths":["shared.txt"],"wait":true}. ` +
        `The call stays pending until the file frees up, so do not poll coord_who and do not repeat it while it waits. ` +
        `When it reports the reservation, append the line "peer" to shared.txt with exactly one separate edit call, then stop. ${noQuestions}`,
    );
    result = await Promise.race([peer.done, delay(300000, null, { ref: false })]);
    assert.ok(result, "Waiting session timed out");
    const claimCalls = result.events.filter((e) => e.type === "tool_use" && e.part.tool === "coord_claim");
    const peerCalls = toolCalls(result);
    const why = JSON.stringify(peerCalls.map((c) => `${c.tool}[${c.status}]:${String(c.output).slice(0, 90)}`));
    assert.equal(claimCalls.length, 1, `Expected exactly one coord_claim call\n${why}`);
    assert.equal(claimCalls[0].part.state.input?.wait, true, "The claim must set wait: true");
    assert.match(String(claimCalls[0].part.state.output ?? ""), /Reserved shared\.txt/);
    const whoCalls = peerCalls.filter((c) => c.tool === "coord_who").length;
    assert.ok(whoCalls <= 1, `The session polled coord_who ${whoCalls} times instead of waiting\n${why}`);
    const writeEvents = result.events.filter(
      (e) => e.type === "tool_use" && ["edit", "write", "patch"].includes(e.part.tool),
    );
    const ownerWrite = owner.state.events
      .filter((e) => e.type === "tool_use" && ["edit", "write", "patch"].includes(e.part.tool))
      .at(-1);
    assert.ok(
      writeEvents.length === 1 && ownerWrite && writeEvents[0].timestamp > ownerWrite.timestamp,
      `Peer wrote at the wrong time\n${why}`,
    );
    const shared = await lines("shared.txt");
    assert.equal(shared.at(-1), "peer", `Peer line missing\n${JSON.stringify(shared.slice(-4))}`);
    assert.equal(shared.filter((l) => l.startsWith("owner step ")).length, steps, "Owner lines were lost");
    extra = { whoCalls, peerTools: [...new Set(peerCalls.map((c) => c.tool))] };
  } else {
    const main = run(
      "final build",
      `Final verification is about to run in this project while another session keeps editing. Make sure no other session ` +
        `can change sources while the verification runs, then run the build with the foreground shell command ./gradlew test. ${noQuestions}`,
    );
    const sawExclusive = await until(
      async () => {
        const s = await snapshot();
        return s.some((p) => p.policy?.phase === "exclusive" && p.paths.includes("build:checkout"));
      },
      240000,
      "No exclusive stable-build state was ever observed",
    ).then(
      () => true,
      (e) => {
        if (main.child.exitCode !== null) return false;
        throw e;
      },
    );
    result = await Promise.race([main.done, delay(300000, null, { ref: false })]);
    assert.ok(result, "Build session timed out");
    const readOnly = (await lines("loop.txt")).length;
    await delay(1500);
    extra = {
      usedCoordExclusive: toolCalls(result).some((c) => c.tool === "coord_exclusive"),
      builds: await lines("builds.log"),
      loopLinesWhenBuildSessionEnded: readOnly,
      loopLinesLater: (await lines("loop.txt")).length,
      ownerNotices: say(
        owner.state.events
          .filter((e) => e.type === "text")
          .map((e) => e.part.text)
          .join(" "),
      ),
      ownerRejectedEdits: edits(owner.state).filter((c) => c.status === "error").length,
    };
    // A live model may rerun a suspicious command several times; protection is judged by the refusals it caused.
    assert.ok(extra.builds.length >= 1, "The build never ran");
    assert.ok(
      extra.ownerRejectedEdits >= 1,
      "The neighbouring session was never refused while sources were protected",
    );
    assert.ok(extra.usedCoordExclusive || sawExclusive, "Sources were not protected through the plugin");
  }
  console.log(`PASS (${scenario}, ${model})`, JSON.stringify(extra));
  console.log(
    "evidence",
    JSON.stringify({
      modelSteps: result.events.filter((e) => e.type === "step_finish").length,
      ownerEdits: edits(owner.state).filter((c) => c.status === "completed").length,
      ownerEditErrors: edits(owner.state).filter((c) => c.status === "error").length,
    }),
  );
} catch (error) {
  console.error("TRACE\n" + (await readFile(path.join(root, "trace.log"), "utf8").catch(() => "(no trace)")));
  console.error("TRANSCRIPT\n" + transcript());
  throw error;
} finally {
  for (const child of children) child.kill();
  for (const id of sessions) {
    try {
      execFileSync("opencode", ["api", "delete", `/api/session/${id}`], { stdio: "ignore", timeout: 20000 });
    } catch {}
  }
  console.log(`Removed ${sessions.size} live test session(s).`);
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
