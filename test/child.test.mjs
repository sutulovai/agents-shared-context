import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Redis } from "ioredis";
import plugin from "../dist/index.js";
import { locate } from "../dist/resources.js";
import { change } from "../dist/store.js";

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asc-child-"));
  execFileSync("git", ["init", "--quiet", directory]);
  let feed;
  const events = new ReadableStream({
    start(controller) {
      feed = controller;
    },
  });
  // The plugin talks to Redis through a proxy the test can switch off to imitate a short outage.
  const upstreamPort = Number(new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379").port || 6379);
  let online = true;
  const proxy = net.createServer((client) => {
    if (!online) return client.destroy();
    const upstream = net.connect(upstreamPort, "127.0.0.1");
    client.on("error", () => client.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const hooks = new Map(),
    tools = new Map();
  const clock = {};
  const hook = async (key, fn) => {
    hooks.set(key, fn);
  };
  const ctx = {
    options: { managed: false, port: proxy.address().port, ...options },
    session: {
      hook,
      get: async ({ sessionID }) => ({
        id: sessionID,
        title: sessionID,
        location: { directory },
        time: clock[sessionID] ?? { busy: Date.now() },
        ...(sessionID === "child" ? { parentID: "parent" } : {}),
      }),
      // The warning path writes a session instruction; without this stub a failure masks itself as a TypeError.
      instructions: { entry: { put: async () => {}, remove: async () => {} } },
    },
    permission: { hook },
    tool: { hook, transform: async (fn) => fn({ add: (t) => tools.set(t.name, t) }) },
    command: { transform: async () => {} },
    event: {
      subscribe: async function* ({ signal }) {
        signal.addEventListener("abort", () => feed.close(), { once: true });
        for await (const { event, handled } of events) {
          yield event;
          handled();
        }
      },
    },
  };
  const cleanup = await plugin.setup(ctx);
  const client = new Redis(upstreamPort, "127.0.0.1");
  // One unload per fixture, whether a test asks for it explicitly or the hook does.
  let cleaned;
  const unload = () => (cleaned ??= cleanup());
  t.after(async () => {
    try {
      await unload();
    } finally {
      client.disconnect();
      proxy.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  const turn = async (sessionID) => {
    const event = { sessionID, tools: { patch: {}, coord_who: {} }, system: [] };
    await hooks.get("context")(event);
    return event;
  };
  return {
    tools,
    hooks,
    turn,
    feed,
    clock,
    directory,
    client,
    cleanup: unload,
    project: (await locate(directory)).project,
    setOnline: (value) => (online = value),
  };
}

const invoke = (tools, name, id, input = {}, signal = new AbortController().signal) =>
  tools.get(name).execute(input, { sessionID: id, signal });

test("a child runs without another join prompt but cannot take its parent's reservation", async (t) => {
  const { tools, hooks, turn, feed } = await fixture(t);
  await turn("parent");
  const held = await tools.get("coord_claim").execute({ paths: ["owned.txt"] }, { sessionID: "parent" });
  assert.match(held.content, /Reserved/);
  await new Promise((handled) =>
    feed.enqueue({ event: { type: "session.idle", data: { sessionID: "parent" } }, handled }),
  );
  assert.ok((await turn("child")).tools.patch);
  const edit = { action: "edit", sessionID: "child", resources: ["owned.txt"], effect: "ask" };
  await hooks.get("evaluate")(edit);
  assert.equal(edit.effect, "deny");
  assert.match(edit.message, /parent/);
  edit.effect = "ask";
  edit.resources = ["other.txt"];
  await hooks.get("evaluate")(edit);
  assert.equal(edit.effect, "ask", "Coordination must not promote an existing approval prompt to allow");
  const observer = await turn("observer");
  assert.equal(observer.tools.patch, undefined);
  assert.ok(observer.tools.coord_who);
});

test("cancelling a draining veto preserves the running shell; a later exclusive owner alone can reopen sharing", async (t) => {
  const { tools, hooks, turn } = await fixture(t);
  await turn("parent");
  await turn("child");
  const shell = {
    tool: "shell",
    input: { command: "git status" },
    id: "call",
    messageID: "msg",
    sessionID: "child",
  };
  await hooks.get("execute.before")(shell);
  const ctl = new AbortController();
  const invoke = (name, id, input = {}, signal = new AbortController().signal) =>
    tools.get(name).execute(input, { sessionID: id, signal });
  const task = invoke("coord_exclusive", "parent", { mode: "work", reason: "Apply migration" }, ctl.signal);
  const who = async () => JSON.parse((await invoke("coord_who", "child")).content);
  for (let i = 0; i < 50 && !(await who()).some((s) => s.policy?.phase === "pending"); i++) await delay(10);
  assert.ok((await who()).some((s) => s.policy?.phase === "pending"));
  ctl.abort();
  await assert.rejects(task, { name: "AbortError" });
  assert.ok((await who()).every((s) => !s.policy));
  await hooks.get("execute.after")({ ...shell, status: "completed", result: { content: "ok" } });
  assert.match(
    (await invoke("coord_exclusive", "parent", { mode: "work", reason: "Apply migration" })).content,
    /exclusive/,
  );
  await invoke("coord_share", "child");
  await assert.rejects(hooks.get("execute.before")(shell), /Read-only/);
  await invoke("coord_share", "parent");
  await hooks.get("execute.before")(shell);
});

test("coord_wait in a parallel session waits until the blocking claim is released", async (t) => {
  const { tools, hooks, turn, feed, clock } = await fixture(t);
  await turn("parent");
  await turn("child");
  await tools.get("coord_claim").execute({ paths: ["owned.txt"] }, { sessionID: "parent" });
  const ctl = new AbortController();
  const waiting = tools
    .get("coord_wait")
    .execute({ paths: ["owned.txt"] }, { sessionID: "child", signal: ctl.signal });
  t.after(() => ctl.abort());
  let settled = false;
  waiting.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 25 && !settled; i++) await delay(20);
  assert.equal(settled, false, "coord_wait returned while another session still held the file");
  clock.parent = { busy: 1, idle: 2 };
  await new Promise((handled) =>
    feed.enqueue({ event: { type: "session.idle", data: { sessionID: "parent" } }, handled }),
  );
  assert.match((await waiting).content, /^Available: no other session holds owned\.txt\.$/);
  const child = await tools.get("coord_who").execute({}, { sessionID: "child" });
  assert.ok(
    JSON.parse(child.content).some((s) => s.id === "child"),
    "Cancelling-free wait must not end membership",
  );
});

test("cancelling coord_wait keeps an established parallel session and its claims", async (t) => {
  const { tools, hooks, turn } = await fixture(t);
  await turn("parent");
  await turn("child");
  await tools.get("coord_claim").execute({ paths: ["owned.txt"] }, { sessionID: "parent" });
  await tools.get("coord_claim").execute({ paths: ["mine.txt"] }, { sessionID: "child" });
  const ctl = new AbortController();
  const waiting = tools.get("coord_wait").execute({}, { sessionID: "child", signal: ctl.signal });
  await delay(100);
  ctl.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  const after = JSON.parse((await tools.get("coord_who").execute({}, { sessionID: "child" })).content);
  assert.deepEqual(
    after.find((s) => s.id === "child")?.paths.map((p) => p.slice(0, p.lastIndexOf("@"))),
    ["file:mine.txt"],
  );
});

test("a shell command that may write files carries the coordination notice once per session", async (t) => {
  const { tools, hooks, turn } = await fixture(t);
  await turn("parent");
  const shell = async (command) => {
    hooks.get("execute.before")({
      tool: "shell",
      input: { command },
      id: command,
      messageID: "m",
      sessionID: "parent",
    });
    const event = {
      tool: "shell",
      input: { command },
      id: command,
      messageID: "m",
      sessionID: "parent",
      status: "completed",
      result: { content: "ok" },
    };
    await hooks.get("execute.after")(event);
    return event.result.content;
  };
  assert.doesNotMatch(await shell("ls -la"), /not coordinated/);
  assert.match(await shell("echo x >> out.txt"), /Shell writes are not coordinated/);
  assert.doesNotMatch(await shell("echo y > other.txt"), /not coordinated/, "The notice must not repeat");
});

test("a veto that Redis no longer holds does not block its own owner", async (t) => {
  const { tools, hooks, turn, client, project } = await fixture(t);
  await turn("parent");
  assert.match(
    (await invoke(tools, "coord_exclusive", "parent", { mode: "work", reason: "Rework" })).content,
    /exclusive/,
  );
  // The lease expires while the laptop sleeps: the whole project field is gone.
  await client.del(project);
  const edit = { action: "edit", sessionID: "parent", resources: ["x.txt"], effect: "ask" };
  await hooks.get("evaluate")(edit);
  assert.equal(edit.effect, "ask", `Owner was denied after lease loss: ${edit.message}`);
  await turn("parent");
  assert.ok((await invoke(tools, "coord_who", "parent")).content.length > 2);
  assert.match(
    (await invoke(tools, "coord_exclusive", "parent", { mode: "work", reason: "Again" })).content,
    /exclusive/,
  );
});

test("a session without a Redis record can request exclusivity in an empty project", async (t) => {
  const { tools } = await fixture(t);
  const reply = await invoke(tools, "coord_exclusive", "solo", { mode: "work", reason: "Start here" });
  assert.match(reply.content, /^Project exclusive for this session\./);
});

test("a conflict names the owning session's title and a short id", async (t) => {
  const { tools, turn } = await fixture(t);
  await turn("holder-a1b2c3");
  await turn("child");
  await invoke(tools, "coord_claim", "holder-a1b2c3", { paths: ["held.txt"] });
  const reply = await invoke(tools, "coord_claim", "child", { paths: ["held.txt"] });
  assert.match(reply.content, /^Conflict: held\.txt is held by holder-a1b2c3 \(a1b2c3\)\.$/);
});

test("a claim on a directory is refused with the reason", async (t) => {
  const { tools, turn, directory } = await fixture(t);
  await mkdir(path.join(directory, "src"));
  await turn("parent");
  await assert.rejects(
    invoke(tools, "coord_claim", "parent", { paths: ["src"] }),
    /Claim individual files; a directory is not reserved: src/,
  );
});

test("a finished call that Redis never acknowledged does not block later exclusivity", async (t) => {
  const { tools, hooks, turn, setOnline } = await fixture(t);
  await turn("parent");
  await turn("child");
  const shell = { tool: "shell", input: { command: "sleep 1" }, id: "call", messageID: "msg", sessionID: "child" };
  await hooks.get("execute.before")(shell);
  setOnline(false);
  await hooks.get("execute.after")({ ...shell, status: "completed", result: { content: "" } });
  setOnline(true);
  await delay(2300);
  const reply = await invoke(tools, "coord_exclusive", "parent", { mode: "work", reason: "After the blip" });
  assert.match(reply.content, /^Project exclusive for this session\./);
});

test("a finished stable build tells its session that source protection ended", async (t) => {
  const { tools, hooks, turn } = await fixture(t);
  await turn("parent");
  await invoke(tools, "coord_exclusive", "parent", { mode: "stable-build", reason: "Verify" });
  const shell = {
    tool: "shell",
    input: { command: "./gradlew test" },
    id: "build",
    messageID: "m",
    sessionID: "parent",
  };
  await hooks.get("execute.before")(shell);
  const event = { ...shell, status: "completed", result: { content: "ok" } };
  await hooks.get("execute.after")(event);
  assert.match(event.result.content, /protection ended/i);
  assert.doesNotMatch((await invoke(tools, "coord_who", "parent")).content, /"policy"/);
});

test("the shell notice survives a failed write command", async (t) => {
  const { tools, hooks, turn } = await fixture(t);
  await turn("parent");
  const shell = async (command, status = "completed") => {
    await hooks.get("execute.before")({
      tool: "shell",
      input: { command },
      id: command + status,
      messageID: "m",
      sessionID: "parent",
    });
    const event = {
      tool: "shell",
      input: { command },
      id: command + status,
      messageID: "m",
      sessionID: "parent",
      status,
      result: { content: "nope" },
    };
    await hooks.get("execute.after")(event);
    return event.result.content;
  };
  await shell("echo x >> missing-dir/out.txt", "error");
  assert.match(await shell("echo y >> out.txt"), /Shell writes are not coordinated/);
});

test("the heartbeat ends an idle session, and plugin cleanup removes every member", async (t) => {
  const { feed, clock, client, project, cleanup, turn } = await fixture(t, { leaseSeconds: 10 });
  await turn("parent");
  await turn("peer");
  const who = async () => (await change(client, project, "who", { id: "x", token: "t", label: "x" })).sessions;
  assert.equal((await who()).length, 2);
  clock.parent = { busy: 1, idle: 2 };
  await new Promise((handled) =>
    feed.enqueue({ event: { type: "session.idle", data: { sessionID: "parent" } }, handled }),
  );
  assert.deepEqual(
    (await who()).map((s) => s.id),
    ["peer"],
    "Idle session kept its membership",
  );
  await cleanup();
  assert.deepEqual(await who(), [], "Plugin unload left members behind");
});
