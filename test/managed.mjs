import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import net from "node:net";
import { test } from "node:test";
import { promisify } from "node:util";
import { RedisConnection } from "../dist/connection.js";

const exec = promisify(execFile);
const docker = async (...args) => (await exec("docker", args, { timeout: 15000 })).stdout.trim();

test("concurrent cold start and stopped-container recovery retain one loopback-only container", async (t) => {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const name = `agents-shared-context-${port}`;
  assert.equal(await docker("ps", "-aq", "--filter", `name=^/${name}$`), "");
  const first = new RedisConnection({ managed: true, port });
  const second = new RedisConnection({ managed: true, port });
  t.after(async () => {
    first.close();
    second.close();
    const owner = await docker(
      "inspect",
      "-f",
      '{{ index .Config.Labels "io.github.sutulovai.agents-shared-context" }}',
      name,
    );
    assert.equal(owner, "1");
    await docker("rm", "-fv", name);
  });
  const results = await Promise.all([first.get(), second.get()]);
  assert.deepEqual(await Promise.all(results.map((r) => r.ping())), ["PONG", "PONG"]);
  const id = await docker("inspect", "-f", "{{.Id}}", name);
  assert.equal(await docker("port", name, "6379"), `127.0.0.1:${port}`);
  first.close();
  second.close();
  await docker("stop", name);
  const third = new RedisConnection({ managed: true, port });
  try {
    assert.equal(await (await third.get()).ping(), "PONG");
    assert.equal(await docker("inspect", "-f", "{{.Id}}", name), id);
  } finally {
    third.close();
  }
});

test("occupied port is not adopted as managed Redis", async (t) => {
  const socket = net.createServer((s) => s.end());
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  const name = `agents-shared-context-${port}`;
  assert.equal(await docker("ps", "-aq", "--filter", `name=^/${name}$`), "");
  const connection = new RedisConnection({ managed: true, port });
  t.after(async () => {
    connection.close();
    await new Promise((resolve) => socket.close(resolve));
    assert.equal(
      await docker(
        "inspect",
        "-f",
        '{{ index .Config.Labels "io.github.sutulovai.agents-shared-context" }}',
        name,
      ),
      "1",
    );
    await docker("rm", "-fv", name);
  });
  await assert.rejects(connection.get());
  assert.equal(socket.listening, true);
});
