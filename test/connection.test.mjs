import assert from "node:assert/strict";
import { test } from "node:test";
import { RedisConnection, checkContainer, localDockerHost } from "../dist/connection.js";

test("refuses unowned containers and non-loopback bindings before starting them", () => {
  const info = {
    Config: { Labels: { "io.github.sutulovai.agents-shared-context": "1" }, Image: "redis:7.4-alpine" },
    HostConfig: { PortBindings: { "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: "6390" }] } },
  };
  assert.doesNotThrow(() => checkContainer(info, 6390));
  assert.throws(() => checkContainer({ ...info, Config: { Labels: {} } }, 6390));
  info.HostConfig.PortBindings["6379/tcp"][0].HostIp = "0.0.0.0";
  assert.throws(() => checkContainer(info, 6390));
});
test("unavailable connection fails promptly without a queued command", async () => {
  const conn = new RedisConnection({ managed: false, port: 1 });
  try {
    await assert.rejects(conn.get());
  } finally {
    conn.close();
  }
});
test("managed mode rejects remote Docker contexts before container operations", () => {
  assert.equal(localDockerHost("unix:///var/run/docker.sock"), "unix:///var/run/docker.sock");
  for (const endpoint of ["ssh://build-host", "tcp://192.0.2.10:2375", "unix://relative"]) {
    assert.throws(() => localDockerHost(endpoint), /local/i);
  }
});
test("managed mode fails with a clear error and creates nothing when the Docker socket is unreachable", async () => {
  const previous = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = "unix:///nonexistent-asc/docker.sock";
  const connection = new RedisConnection({ managed: true, port: 6390 });
  try {
    await assert.rejects(connection.get(), /docker|ENOENT|connect|No such/i);
  } finally {
    connection.close();
    if (previous === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previous;
  }
});
