import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { Redis } from "ioredis";
import { change } from "../dist/store.js";

let redis;
const key = `asc-test:${randomUUID()}`;
const a = { id: "session-a", token: "first", label: "Rename method" };
const b = { id: "session-b", token: "second", label: "Test method" };
const run = (op, owner, paths = [], ttl = 600000, project = key) => change(redis, project, op, owner, paths, ttl);
const call = (op, owner, id, files = []) => change(redis, key, op, owner, files, 600000, id);
const veto = (owner, mode = "work", ttl = 600000) =>
  change(redis, key, "exclusive", owner, [], ttl, "request", { mode, reason: "Release verification" });

test("exclusive work mode lets the holder edit a file another session keeps claiming", async () => {
  await run("parallel", a);
  await run("parallel", b);
  await run("claim", b, ["held"]);
  assert.equal((await run("claim", a, ["held"])).status, "conflict");
  assert.equal(
    (await change(redis, key, "exclusive", a, [], 600000, "r", { mode: "work", reason: "Rework" })).status,
    "exclusive",
  );
  assert.equal((await run("claim", a, ["held"])).status, "acquired");
  assert.equal((await run("claim", b, ["other"])).status, "read-only");
  await change(redis, key, "share", a, [], 600000, "r");
  assert.equal((await run("claim", b, ["other"])).status, "acquired", "Sharing must restore ordinary access");
  await Promise.all([a, b].map((o) => run("leave", o)));
});

test("a probe reports what blocks a parallel session without taking anything", async () => {
  await run("parallel", a);
  await run("parallel", b);
  const probe = (owner, paths = []) => change(redis, key, "probe", owner, paths, 600000, "");
  assert.equal((await probe(b)).status, "ok");
  await run("claim", a, ["held"]);
  assert.equal((await probe(b, ["free"])).status, "ok");
  const blocked = await probe(b, ["held"]);
  assert.deepEqual(
    [blocked.status, blocked.owner, blocked.path, blocked.label],
    ["conflict", a.id, "held", a.label],
  );
  assert.equal((await probe(b)).path, "held");
  assert.deepEqual((await run("who", b)).sessions.find((s) => s.id === b.id).paths, []);
  await run("leave", a);
  assert.equal((await probe(b, ["held"])).status, "ok");
  await run("leave", b);
});

before(async () => {
  redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
    lazyConnect: true,
    retryStrategy: () => null,
  });
  await redis.connect();
});
after(async () => {
  redis.disconnect();
});

test("only one simultaneous arrival starts; waiters do not keep each other waiting", async () => {
  const results = await Promise.all([run("join", a), run("join", b)]);
  assert.deepEqual(results.map((x) => x.status).sort(), ["active", "waiting"]);
  const [winner, waiter] = results[0].status === "active" ? [a, b] : [b, a];
  await run("leave", winner);
  assert.equal((await run("join", waiter)).status, "active");
  await run("leave", waiter);
});

test("project probes ignore waiting peers and observe active peers without paths", async () => {
  const guest = { id: "session-c", token: "third", label: "Another waiter" };
  assert.equal((await run("parallel", a)).status, "active");
  assert.equal((await run("join", b)).status, "waiting");
  assert.equal((await run("join", guest)).status, "waiting");
  assert.equal((await run("project-probe", b)).owner, a.id);
  await run("leave", a);
  assert.equal((await run("project-probe", b)).status, "ok");
  assert.equal((await run("project-probe", guest)).status, "ok");
  await Promise.all([b, guest].map((owner) => run("leave", owner)));
});

test("project-wait markers never hide file claims, in-flight work, or resumed sessions", async () => {
  await run("parallel", a);
  await run("parallel", b);
  await run("claim", b, ["held"]);
  assert.equal((await run("project-probe", b)).status, "waiting");
  assert.equal((await run("claim", a, ["held"])).status, "conflict");
  assert.equal((await call("stage", b, "edit", ["busy"])).status, "acquired");
  assert.equal((await run("project-probe", b)).status, "waiting");
  assert.equal((await run("project-probe", a)).owner, b.id);
  await call("finish", b, "edit");
  await run("project-unwait", b);
  assert.equal((await run("project-probe", a)).owner, b.id);
  await Promise.all([a, b].map((owner) => run("leave", owner)));
});

test("a project wait cannot bypass a waiting peer's veto", async () => {
  await run("parallel", a);
  await run("parallel", b);
  assert.equal((await run("project-probe", a)).status, "waiting");
  assert.equal((await veto(a)).status, "exclusive");
  assert.equal((await run("project-probe", b)).status, "read-only");
  await call("share", a, "request");
  await Promise.all([a, b].map((owner) => run("leave", owner)));
});

test("an old wait cannot clear a newer project's wait marker", async () => {
  await run("parallel", a);
  await run("parallel", b);
  await call("project-probe", b, "old");
  await call("project-probe", b, "new");
  await call("project-unwait", b, "old");
  assert.equal(JSON.parse(await redis.hget(key, b.id)).projectWaitRequest, "new");
  await call("project-unwait", b, "new");
  await Promise.all([a, b].map((owner) => run("leave", owner)));
});

test("an incumbent drains in-flight work; neither a peer nor a newcomer can override its veto", async () => {
  const guest = { ...b, id: "guest" };
  await run("parallel", a);
  await run("parallel", b);
  await run("claim", b, ["idle-file"]);
  await call("stage", b, "edit", ["busy-file"]);
  assert.equal((await veto(a, "stable-build")).status, "pending");
  assert.equal((await run("parallel", guest)).status, "read-only");
  assert.equal((await run("claim", guest, ["other"])).status, "read-only");
  assert.equal((await veto(b)).status, "read-only");
  await call("share", b, "request");
  assert.equal((await call("stage", b, "new", ["x"])).status, "read-only");
  let report = (await run("who", guest)).sessions.find((s) => s.id === a.id);
  assert.equal(report.policy.phase, "pending");
  assert.equal(report.policy.reason, "Release verification");
  assert.ok(!report.paths.includes("build:checkout"));
  await call("finish", b, "edit");
  assert.equal((await veto(a, "stable-build")).status, "exclusive");
  report = (await run("who", guest)).sessions.find((s) => s.id === a.id);
  assert.ok(report.paths.includes("build:checkout"));
  assert.equal((await call("stage", a, "own-edit", ["x"])).status, "read-only");
  await call("share", a, "wrong");
  assert.equal((await run("parallel", guest)).status, "read-only");
  await call("share", a, "request");
  assert.equal((await run("parallel", guest)).status, "active");
  await Promise.all([a, b, guest].map((o) => run("leave", o)));
});

test("cancellation releases pending policy; expired exclusive owner cannot release its successor", async () => {
  await run("parallel", a);
  await run("parallel", b);
  await run("claim", b, ["build:checkout"]);
  assert.equal((await veto(a)).status, "pending");
  await call("share", a, "request");
  assert.equal((await run("claim", b, ["other"])).status, "acquired");
  await run("leave", b);
  await run("parallel", b);
  assert.equal((await veto(a, "work", 30)).status, "exclusive");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await veto(b)).status, "exclusive");
  assert.equal((await call("share", a, "request")).status, "lost");
  assert.equal((await run("parallel", a)).status, "read-only");
  await Promise.all([a, b].map((o) => run("leave", o)));
});

test("competing multi-path edits are all-or-nothing and isolated by project", async () => {
  await Promise.all([run("parallel", a), run("parallel", b)]);
  const [x, y] = await Promise.all([run("claim", a, ["a", "shared"]), run("claim", b, ["b", "shared"])]);
  assert.deepEqual([x.status, y.status].sort(), ["acquired", "conflict"]);
  const [winner, loser] = x.status === "acquired" ? [a, b] : [b, a];
  const refused = x.status === "conflict" ? x : y;
  assert.equal(refused.label, winner.label, "Conflicts should name the owner's session title, not only its ID");
  const report = await run("who", loser);
  assert.deepEqual(report.sessions.find((s) => s.id === loser.id).paths, []);
  assert.ok(!JSON.stringify(report).includes(winner.token));
  const other = `${key}:other`;
  await run("parallel", loser, [], 500, other);
  assert.equal((await run("claim", loser, ["shared"], 500, other)).status, "acquired");
  await Promise.all([run("leave", a), run("leave", b)]);
});

test("expired token cannot renew or delete a replacement, even with the same session ID", async () => {
  const newOwner = { ...a, token: "replacement" };
  await run("parallel", a, [], 25);
  await run("claim", a, ["x"], 25);
  await new Promise((resolve) => setTimeout(resolve, 65));
  await run("parallel", newOwner);
  await run("claim", newOwner, ["x"]);
  assert.equal((await run("parallel", a)).status, "occupied");
  assert.equal((await run("renew", a)).status, "lost");
  assert.equal((await run("leave", a)).status, "lost");
  assert.deepEqual((await run("who", a)).sessions[0].paths, ["x"]);
  await run("leave", newOwner);
});

test("renewal outlives the original TTL and waiters never acquire edits", async () => {
  await run("parallel", a, [], 600);
  await run("claim", a, ["shared"], 600);
  assert.equal((await run("join", b)).status, "waiting");
  assert.equal((await run("claim", b, ["independent"])).status, "waiting");
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal((await run("renew", a, [], 600)).status, "ok");
  }
  const snapshot = (await run("who", b)).sessions.find((s) => s.id === a.id);
  assert.ok(snapshot.expiresInMs > 0 && snapshot.expiresInMs <= 600);
  await run("leave", a);
  assert.equal((await run("join", b)).status, "active");
  await run("leave", b);
});

test("failed edit releases only its own provisional claims, including overlapping in-flight calls", async () => {
  await run("parallel", a);
  await run("claim", a, ["preclaimed"]);
  await call("stage", a, "one", ["preclaimed", "shared", "unused"]);
  await call("stage", a, "two", ["shared", "written"]);
  await call("abandon", a, "one");
  assert.deepEqual((await run("who", a)).sessions[0].paths, ["preclaimed", "shared", "written"]);
  await call("finish", a, "two");
  await call("stage", a, "three", ["written", "retry"]);
  await call("abandon", a, "three");
  assert.deepEqual((await run("who", a)).sessions[0].paths, ["preclaimed", "shared", "written"]);
  await run("leave", a);
});
