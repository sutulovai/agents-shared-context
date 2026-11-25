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
  let dropStage = false;
  let holdOperation;
  const sockets = new Set();
  const proxy = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    if (!online) return client.destroy();
    const upstream = net.connect(upstreamPort, "127.0.0.1");
    let discardReply = false;
    client.on("error", () => client.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("data", (data) => {
      if (holdOperation && data.includes(Buffer.from(`\r\n${holdOperation.name}\r\n`))) {
        const held = holdOperation;
        holdOperation = undefined;
        held.seen();
        held.release.then(() => upstream.write(data));
        return;
      }
      if (dropStage && data.includes(Buffer.from("\r\nstage\r\n"))) {
        dropStage = false;
        discardReply = true;
        upstream.write(data);
      } else upstream.write(data);
    });
    upstream.on("data", (data) => {
      if (discardReply) client.destroy();
      else client.write(data);
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const hooks = new Map(),
    tools = new Map(),
    commands = new Map();
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
      prompt: async () => {},
    },
    permission: { hook },
    tool: { hook, transform: async (fn) => fn({ add: (t) => tools.set(t.name, t) }) },
    command: { transform: async (fn) => fn({ add: (c) => commands.set(c.name, c) }) },
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
    commands,
    hooks,
    turn,
    feed,
    clock,
    directory,
    client,
    cleanup: unload,
    project: (await locate(directory)).project,
    setOnline: (value) => {
      online = value;
      if (!value) for (const socket of sockets) socket.destroy();
    },
    dropStage: () => (dropStage = true),
    hold: (name) => {
      let seen;
      let release;
      const observed = new Promise((resolve) => (seen = resolve));
      const released = new Promise((resolve) => (release = resolve));
      holdOperation = { name, seen, release: released };
      return { observed, release };
    },
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
  assert.ok(observer.tools.patch, "Default parallel admission leaves edit tools available");
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

test("slash wait blocks on a claimless peer and reports progress", async (t) => {
  const { tools, commands, turn, feed, clock } = await fixture(t);
  await turn("parent");
  await commands.get("coord-wait").execute({ sessionID: "newcomer", delivery: "append" });
  await turn("newcomer");
  const ctl = new AbortController();
  t.after(() => ctl.abort());
  const progress = [];
  const waiting = tools.get("coord_wait").execute(
    {},
    {
      sessionID: "newcomer",
      signal: ctl.signal,
      progress: async (update) => progress.push(update),
    },
  );
  let settled = false;
  waiting.finally(() => (settled = true)).catch(() => {});
  await delay(200);
  assert.equal(settled, false, "A peer without claims still blocks project wait");
  assert.ok(progress.length, "A blocked wait publishes progress");
  clock.parent = { busy: 1, idle: 2 };
  await new Promise((handled) =>
    feed.enqueue({ event: { type: "session.idle", data: { sessionID: "parent" } }, handled }),
  );
  assert.match((await waiting).content, /Available/);
  await turn("another");
  assert.ok((await turn("newcomer")).tools.patch, "Completed command must not gate unrelated turns");
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
  assert.match((await waiting).content, /not a reservation; re-read and claim files before editing/);
  const child = await tools.get("coord_who").execute({}, { sessionID: "child" });
  assert.ok(
    JSON.parse(child.content).some((s) => s.id === "child"),
    "Cancelling-free wait must not end membership",
  );
});

test("slash wait keeps newcomers waiting rather than activating them", async (t) => {
  const { tools, commands, turn, client, project } = await fixture(t);
  await turn("parent");
  for (const id of ["first", "second"]) {
    await commands.get("coord-wait").execute({ sessionID: id, delivery: "append" });
    await turn(id);
  }
  const records = await client.hgetall(project);
  assert.equal(JSON.parse(records.first).state, "waiting");
  assert.equal(JSON.parse(records.second).state, "waiting");
  const ctl = new AbortController();
  const calls = ["first", "second"].map((id) =>
    tools.get("coord_wait").execute({}, { sessionID: id, signal: ctl.signal, progress: async () => {} }),
  );
  await delay(100);
  ctl.abort();
  await Promise.all(calls.map((call) => assert.rejects(call, { name: "AbortError" })));
});

test("an idle command without a tool call does not gate the next turn", async (t) => {
  const { commands, turn, feed, clock } = await fixture(t);
  await turn("parent");
  await commands.get("coord-wait").execute({ sessionID: "newcomer", delivery: "append" });
  clock.newcomer = { busy: 1, idle: 2 };
  await new Promise((handled) =>
    feed.enqueue({ event: { type: "session.idle", data: { sessionID: "newcomer" } }, handled }),
  );
  clock.newcomer = { busy: Date.now() };
  assert.ok((await turn("newcomer")).tools.patch);
});

test("cancelling an old project wait after switching to parallel preserves resumed work", async (t) => {
  const { tools, commands, turn, hooks, client, project } = await fixture(t);
  await turn("parent");
  await commands.get("coord-wait").execute({ sessionID: "newcomer", delivery: "append" });
  await turn("newcomer");
  const ctl = new AbortController();
  const waiting = tools.get("coord_wait").execute(
    {},
    {
      sessionID: "newcomer",
      signal: ctl.signal,
      progress: async () => {},
    },
  );
  await delay(100);
  await commands.get("coord-parallel").execute({ sessionID: "newcomer", delivery: "append" });
  await turn("newcomer");
  assert.match((await invoke(tools, "coord_claim", "newcomer", { paths: ["mine.txt"] })).content, /Reserved/);
  const shell = {
    tool: "shell",
    input: { command: "git status" },
    id: "call",
    messageID: "msg",
    sessionID: "newcomer",
  };
  await hooks.get("execute.before")(shell);
  const before = JSON.parse(await client.hget(project, "newcomer"));
  ctl.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  const after = JSON.parse(await client.hget(project, "newcomer"));
  assert.equal(after.token, before.token);
  assert.deepEqual(after.paths, before.paths);
  assert.deepEqual(after.pending, before.pending);
});

test("cancelling a superseded wait does not clear a newer wait", async (t) => {
  const { tools, commands, turn } = await fixture(t);
  await turn("parent");
  const old = new AbortController();
  const current = new AbortController();
  t.after(() => current.abort());
  await commands.get("coord-wait").execute({ sessionID: "newcomer", delivery: "append" });
  await turn("newcomer");
  const first = tools.get("coord_wait").execute(
    {},
    {
      sessionID: "newcomer",
      signal: old.signal,
      progress: async () => {},
    },
  );
  await delay(100);
  await commands.get("coord-wait").execute({ sessionID: "newcomer", delivery: "append" });
  const second = tools.get("coord_wait").execute(
    {},
    {
      sessionID: "newcomer",
      signal: current.signal,
      progress: async () => {},
    },
  );
  await delay(100);
  old.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.ok(!(await turn("newcomer")).tools.patch, "Newer wait must still gate edits");
  current.abort();
  await assert.rejects(second, { name: "AbortError" });
});

test("cancelling slash wait preserves an active session's claims", async (t) => {
  const { tools, commands, turn, client, project } = await fixture(t);
  await turn("parent");
  await turn("child");
  await invoke(tools, "coord_claim", "child", { paths: ["mine.txt"] });
  await commands.get("coord-wait").execute({ sessionID: "child", delivery: "append" });
  await turn("child");
  const ctl = new AbortController();
  const waiting = tools.get("coord_wait").execute(
    {},
    {
      sessionID: "child",
      signal: ctl.signal,
      progress: async () => {},
    },
  );
  await delay(100);
  ctl.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  const sessions = JSON.parse((await invoke(tools, "coord_who", "child")).content);
  assert.ok(sessions.find((s) => s.id === "child")?.paths.some((p) => p.startsWith("file:mine.txt@")));
  assert.equal(JSON.parse(await client.hget(project, "child")).projectWaitUntil, undefined);
});

test("two established project waiters make progress without losing their claims", async (t) => {
  const { tools, commands, turn, feed, clock } = await fixture(t);
  await turn("parent");
  await turn("child");
  await invoke(tools, "coord_claim", "parent", { paths: ["parent.txt"] });
  await invoke(tools, "coord_claim", "child", { paths: ["child.txt"] });
  const ctl = new AbortController();
  t.after(() => ctl.abort());
  const progress = [];
  const start = async (id) => {
    await commands.get("coord-wait").execute({ sessionID: id, delivery: "append" });
    return tools
      .get("coord_wait")
      .execute({}, { sessionID: id, signal: ctl.signal, progress: async (v) => progress.push(v) });
  };
  const first = start("parent");
  first.catch(() => {});
  for (let i = 0; i < 100 && !progress.length; i++) await delay(10);
  assert.ok(progress.length, "First waiter must see the active peer");
  const second = start("child");
  second.catch(() => {});
  const winner = await Promise.race([
    first.then(() => "parent"),
    second.then(() => "child"),
    delay(2500, "timeout"),
  ]);
  assert.notEqual(winner, "timeout", "Established waiters must not deadlock each other");
  const completed = winner === "parent" ? first : second;
  assert.equal((await completed).content, "Available: no participant is blocking this project wait. Resume work.");
  const records = JSON.parse((await invoke(tools, "coord_who", winner)).content);
  assert.ok(records.find((p) => p.id === "parent").paths.some((p) => p.startsWith("file:parent.txt@")));
  assert.ok(records.find((p) => p.id === "child").paths.some((p) => p.startsWith("file:child.txt@")));
  clock[winner] = { busy: 1, idle: 2 };
  await new Promise((handled) =>
    feed.enqueue({ event: { type: "session.idle", data: { sessionID: winner } }, handled }),
  );
  const remaining = winner === "parent" ? second : first;
  assert.match((await remaining).content, /Available/);
});

test("wait progress changes only when its blocker changes", async (t) => {
  const { tools, commands, turn, feed, clock } = await fixture(t);
  await turn("parent");
  await turn("other");
  await turn("child");
  await commands.get("coord-wait").execute({ sessionID: "child", delivery: "append" });
  const ctl = new AbortController();
  t.after(() => ctl.abort());
  const progress = [];
  const waiting = tools
    .get("coord_wait")
    .execute({}, { sessionID: "child", signal: ctl.signal, progress: async (value) => progress.push(value) });
  waiting.catch(() => {});
  await delay(1700);
  assert.equal(progress.length, 1, JSON.stringify(progress));
  const blocker = progress[0].title.includes("parent") ? "parent" : "other";
  clock[blocker] = { busy: 1, idle: 2 };
  await new Promise((handled) =>
    feed.enqueue({ event: { type: "session.idle", data: { sessionID: blocker } }, handled }),
  );
  await delay(1600);
  assert.equal(progress.length, 2, JSON.stringify(progress));
  assert.notEqual(progress[0].title, progress[1].title);
  ctl.abort();
  await assert.rejects(waiting, { name: "AbortError" });
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

test("a lost veto can be requested again without an intervening edit", async (t) => {
  const { tools, turn, client, project } = await fixture(t);
  await turn("parent");
  await invoke(tools, "coord_exclusive", "parent", { mode: "work", reason: "First" });
  await client.del(project);
  assert.match(
    (await invoke(tools, "coord_exclusive", "parent", { mode: "work", reason: "Again" })).content,
    /exclusive/,
  );
});

test("a duplicate exclusive request during admission cannot replace the first", async (t) => {
  const { tools, turn, hold } = await fixture(t);
  await turn("parent");
  const gate = hold("parallel");
  const first = invoke(tools, "coord_exclusive", "parent", { mode: "work", reason: "First" });
  await gate.observed;
  const second = invoke(tools, "coord_exclusive", "parent", { mode: "work", reason: "Second" });
  await delay(50);
  gate.release();
  assert.match((await second).content, /already requested/);
  assert.match((await first).content, /^Project exclusive/);
});

test("a refused restage does not discard an earlier stage of the same call", async (t) => {
  const { tools, hooks, turn } = await fixture(t);
  await turn("parent");
  await turn("child");
  await invoke(tools, "coord_claim", "child", { paths: ["held.txt"] });
  const edit = {
    action: "edit",
    sessionID: "parent",
    resources: ["mine.txt"],
    effect: "ask",
    source: { type: "tool", messageID: "m", id: "edit" },
  };
  await hooks.get("evaluate")(edit);
  assert.equal(edit.effect, "ask");
  const refused = { ...edit, resources: ["held.txt"] };
  await hooks.get("evaluate")(refused);
  assert.equal(refused.effect, "deny");
  await hooks.get("execute.after")({
    tool: "edit",
    sessionID: "parent",
    messageID: "m",
    id: "edit",
    status: "completed",
    result: { content: "ok" },
  });
  const reply = await invoke(
    tools,
    "coord_exclusive",
    "child",
    { mode: "work", reason: "Next" },
    AbortSignal.timeout(1500),
  );
  assert.match(reply.content, /^Project exclusive/);
  const parent = JSON.parse((await invoke(tools, "coord_who", "child")).content).find((s) => s.id === "parent");
  assert.ok(parent.paths.some((p) => p.startsWith("file:mine.txt")));
});

test("a protected build cannot start after its grant is lost", async (t) => {
  const { tools, hooks, turn, client, project } = await fixture(t);
  await turn("parent");
  await invoke(tools, "coord_exclusive", "parent", { mode: "stable-build", reason: "Verify" });
  await client.del(project);
  const shell = {
    tool: "shell",
    input: { command: "npm test" },
    id: "build",
    messageID: "m",
    sessionID: "parent",
  };
  await assert.rejects(hooks.get("execute.before")(shell), /protection|grant/i);
});

test("a lost stable grant survives an intervening ordinary edit until the build is refused", async (t) => {
  const { tools, hooks, turn, client, project } = await fixture(t);
  await turn("parent");
  await invoke(tools, "coord_exclusive", "parent", { mode: "stable-build", reason: "Verify" });
  await client.del(project);
  const edit = { action: "edit", sessionID: "parent", resources: ["x.txt"], effect: "ask" };
  await hooks.get("evaluate")(edit);
  assert.equal(edit.effect, "ask");
  const shell = {
    tool: "shell",
    input: { command: "npm test" },
    id: "build",
    messageID: "m",
    sessionID: "parent",
  };
  await assert.rejects(hooks.get("execute.before")(shell), /protection|grant/i);
  await hooks.get("execute.before")({ ...shell, id: "ordinary" });
});

test("explicit sharing cancels a lost stable-build expectation", async (t) => {
  const { tools, hooks, turn, client, project } = await fixture(t);
  await turn("parent");
  await invoke(tools, "coord_exclusive", "parent", { mode: "stable-build", reason: "Verify" });
  await client.del(project);
  await hooks.get("evaluate")({ action: "edit", sessionID: "parent", resources: ["x.txt"], effect: "ask" });
  await invoke(tools, "coord_share", "parent");
  await hooks.get("execute.before")({
    tool: "shell",
    input: { command: "npm test" },
    id: "build",
    messageID: "m",
    sessionID: "parent",
  });
});

test("an ambiguous protected restage abandons an existing call without an after callback", async (t) => {
  const { tools, hooks, turn, client, project, dropStage } = await fixture(t);
  await turn("parent");
  await turn("child");
  const shell = {
    tool: "shell",
    input: { command: "git status" },
    id: "build",
    messageID: "m",
    sessionID: "parent",
  };
  await hooks.get("execute.before")(shell);
  await client.del(project);
  await turn("child");
  await invoke(tools, "coord_claim", "parent", { paths: ["kept.txt"] });
  await invoke(tools, "coord_exclusive", "parent", { mode: "stable-build", reason: "Verify" });
  dropStage();
  await assert.rejects(
    hooks.get("execute.before")({ ...shell, input: { command: "npm test" } }),
    /protection|grant/i,
  );
  await delay(2300);
  await invoke(tools, "coord_share", "parent");
  const reply = await invoke(
    tools,
    "coord_exclusive",
    "child",
    { mode: "work", reason: "Next" },
    AbortSignal.timeout(1500),
  );
  assert.match(reply.content, /^Project exclusive/);
  const parent = JSON.parse((await invoke(tools, "coord_who", "child")).content).find((s) => s.id === "parent");
  assert.ok(parent.paths.some((p) => p.startsWith("file:kept.txt")));
});

test("an unverifiable protected build stops while an ordinary build fails open", async (t) => {
  const { tools, hooks, turn, setOnline } = await fixture(t);
  await turn("parent");
  await turn("child");
  await invoke(tools, "coord_exclusive", "parent", { mode: "stable-build", reason: "Verify" });
  setOnline(false);
  const shell = {
    tool: "shell",
    input: { command: "npm test" },
    id: "build",
    messageID: "m",
    sessionID: "parent",
  };
  await assert.rejects(hooks.get("execute.before")(shell), /protection|grant/i);
  await hooks.get("execute.before")({ ...shell, sessionID: "child" });
});

test("a lost protected stage reply is abandoned without an after callback", async (t) => {
  const { tools, hooks, turn, dropStage } = await fixture(t);
  await turn("parent");
  await turn("child");
  await invoke(tools, "coord_exclusive", "parent", { mode: "stable-build", reason: "Verify" });
  dropStage();
  const shell = {
    tool: "shell",
    input: { command: "npm test" },
    id: "build",
    messageID: "m",
    sessionID: "parent",
  };
  await assert.rejects(hooks.get("execute.before")(shell), /protection|grant/i);
  await delay(2300);
  await invoke(tools, "coord_share", "parent");
  const reply = await invoke(
    tools,
    "coord_exclusive",
    "child",
    { mode: "work", reason: "Next" },
    AbortSignal.timeout(1500),
  );
  assert.match(reply.content, /^Project exclusive/);
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
  await turn("child");
  const reply = await invoke(
    tools,
    "coord_exclusive",
    "parent",
    { mode: "work", reason: "After the blip" },
    AbortSignal.timeout(1500),
  );
  assert.match(reply.content, /^Project exclusive for this session\./);
  assert.ok(JSON.parse((await invoke(tools, "coord_who", "parent")).content).some((s) => s.id === "child"));
});

test("an applied stage with a lost reply is settled without ending its session", async (t) => {
  const { tools, hooks, turn, dropStage } = await fixture(t);
  await turn("parent");
  await turn("child");
  const shell = { tool: "shell", input: { command: "sleep 1" }, id: "call", messageID: "msg", sessionID: "child" };
  dropStage();
  await hooks.get("execute.before")(shell);
  await hooks.get("execute.after")({ ...shell, status: "completed", result: { content: "" } });
  await delay(2300);
  await turn("child");
  const reply = await invoke(
    tools,
    "coord_exclusive",
    "parent",
    { mode: "work", reason: "After the blip" },
    AbortSignal.timeout(1500),
  );
  assert.match(reply.content, /^Project exclusive for this session\./);
  assert.ok(JSON.parse((await invoke(tools, "coord_who", "parent")).content).some((s) => s.id === "child"));
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

test("a top-level newcomer joins an active project in parallel by default", async (t) => {
  const { tools, turn, directory } = await fixture(t);
  await turn("parent");
  await turn("peer");
  const held = await invoke(tools, "coord_claim", "parent", { paths: ["owned.txt"] });
  assert.match(held.content, /Reserved/);
  const disjoint = await invoke(tools, "coord_claim", "peer", { paths: ["other.txt"] });
  assert.match(disjoint.content, /Reserved/, "Default admission asked instead of joining in parallel");
  const conflict = await invoke(tools, "coord_claim", "peer", { paths: ["owned.txt"] });
  assert.match(conflict.content, /Conflict/);
  await rm(directory, { recursive: true, force: true });
});
