import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("../", import.meta.url));
// The managed install lets OpenCode start Redis itself; every other mode needs one beforehand.
if (process.env.ASC_INSTALL !== "global-managed")
  execFileSync(process.execPath, [path.join(checkout, "test/require-redis.mjs")], { stdio: "inherit" });
const root = await mkdtemp(path.join(os.tmpdir(), "asc-package-"));
try {
  execFileSync("npm", ["run", "build"], { cwd: checkout, stdio: "inherit" });
  const [pack] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], {
      cwd: checkout,
      encoding: "utf8",
    }),
  );
  const files = pack.files.map((f) => f.path).sort();
  assert.deepEqual(files, [
    "LICENSE",
    "README.md",
    "dist/connection.js",
    "dist/index.js",
    "dist/resources.js",
    "dist/store.js",
    "package.json",
  ]);
  const consumer = path.join(root, "consumer");
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), '{"private":true}');
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(root, pack.filename)], {
    cwd: consumer,
    stdio: "inherit",
  });
  // Outage scenarios inject their own port and cannot run against the managed global install.
  const unmanagedOnly = new Set(["outage", "recover", "deny", "lost-grant", "ambiguous-deny"]);
  for (const scenario of [
    "patch",
    "nested",
    "mixed",
    "rollback",
    "join-parallel",
    "join-wait",
    "join-default-wait",
    "join-cancel",
    "build",
    "veto",
    "failed-build",
    "lost-grant",
    "ambiguous-deny",
    "outage",
    "recover",
    "deny",
  ].filter((s) => !(process.env.ASC_INSTALL === "global-managed" && unmanagedOnly.has(s)))) {
    execFileSync(process.execPath, [path.join(checkout, "test/acceptance.mjs")], {
      timeout: 100000,
      stdio: "inherit",
      env: { ...process.env, ASC_PACKAGE: path.join(consumer, "node_modules", pack.name), ASC_SCENARIO: scenario },
    });
  }
  console.log(`Verified packed artifact: ${pack.filename}; ${files.length} files.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
