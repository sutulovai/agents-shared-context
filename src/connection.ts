import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Redis } from "ioredis";

const exec = promisify(execFile);
const label = "io.github.sutulovai.agents-shared-context";
const image = "redis:7.4-alpine";
type Container = {
  Config: { Labels?: Record<string, string>; Image: string };
  HostConfig: { PortBindings?: Record<string, { HostIp: string; HostPort: string }[]> };
  State: { Running: boolean };
};

export function checkContainer(info: Container, port: number) {
  const bindings = info.HostConfig.PortBindings?.["6379/tcp"];
  if (
    info.Config.Labels?.[label] !== "1" ||
    info.Config.Image !== image ||
    bindings?.length !== 1 ||
    bindings[0]?.HostIp !== "127.0.0.1" ||
    bindings[0].HostPort !== String(port)
  ) {
    throw new Error("Managed Redis container has unexpected ownership or port binding");
  }
}

export function localDockerHost(endpoint: string) {
  if (!endpoint.startsWith("unix:///")) throw new Error("Managed Redis requires a local Docker Unix socket");
  return endpoint;
}

async function ensureContainer(port: number) {
  const name = `agents-shared-context-${port}`;
  const endpoint = localDockerHost(
    (
      process.env.DOCKER_HOST ||
      (await exec("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { timeout: 2000 }))
        .stdout
    ).trim(),
  );
  const docker = (...args: string[]) =>
    exec("docker", ["--host", endpoint, ...args], { timeout: 5000, maxBuffer: 128 * 1024 });
  const inspect = async () => {
    const { stdout } = await docker("container", "inspect", name);
    const [info] = JSON.parse(stdout) as Container[];
    if (!info) throw new Error("Missing container");
    checkContainer(info, port);
    return info;
  };
  let info;
  try {
    info = await inspect();
  } catch (error) {
    if (!/no such (container|object)/i.test(String(error))) throw error;
    try {
      await docker(
        "create",
        "--name",
        name,
        "--label",
        `${label}=1`,
        "-p",
        `127.0.0.1:${port}:6379`,
        image,
        "redis-server",
        "--save",
        "",
        "--appendonly",
        "no",
      );
    } catch (e) {
      if (!/already in use/i.test(String(e))) throw e;
    }
    // A competing create reserves the name before Docker makes the container inspectable.
    for (let attempt = 0; ; attempt++) {
      try {
        info = await inspect();
        break;
      } catch (e) {
        if (attempt >= 10 || !/no such (container|object)/i.test(String(e))) throw e;
        await delay(100);
      }
    }
  }
  if (!info.State.Running) await docker("start", name);
}

export class RedisConnection {
  private client?: Redis;
  private starting?: Promise<Redis>;
  private closed = false;
  private retryAfter = 0;
  constructor(private options: { managed: boolean; port: number }) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
      throw new RangeError("Invalid Redis port");
  }
  async get(): Promise<Redis> {
    if (this.closed) throw new Error("Connection closed");
    if (this.client?.status === "ready") return this.client;
    if (this.starting) return this.starting;
    if (Date.now() < this.retryAfter) throw new Error("Redis unavailable; retrying shortly");
    this.starting = this.connect()
      .catch((error) => {
        this.retryAfter = Date.now() + 2000;
        throw error;
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }
  private async connect(): Promise<Redis> {
    if (this.client) {
      this.client.disconnect();
      this.client = undefined;
    }
    if (this.options.managed) await ensureContainer(this.options.port);
    const until = Date.now() + (this.options.managed ? 2500 : 0);
    do {
      if (this.closed) throw new Error("Connection closed");
      const client = new Redis({
        host: "127.0.0.1",
        port: this.options.port,
        lazyConnect: true,
        connectTimeout: 750,
        commandTimeout: 1500,
        enableOfflineQueue: false,
        retryStrategy: () => null,
        autoResendUnfulfilledCommands: false,
        maxRetriesPerRequest: 0,
      });
      client.on("error", () => {});
      try {
        await client.connect();
        const [command] = (await client.call("COMMAND", "INFO", "HPEXPIRE")) as unknown[];
        if (!command) throw new Error("Redis 7.4 or newer is required");
        if (this.closed) throw new Error("Connection closed");
        this.client = client;
        return client;
      } catch (e) {
        client.disconnect();
        if (Date.now() >= until) throw e;
        await delay(100);
      }
    } while (!this.closed);
    throw new Error("Connection closed");
  }
  close() {
    this.closed = true;
    this.client?.disconnect();
  }
}
