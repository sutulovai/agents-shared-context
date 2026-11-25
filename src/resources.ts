import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface Scope {
  project: string;
  root: string;
  directory: string;
}

export async function locate(cwd: string): Promise<Scope> {
  const directory = await realpath(cwd);
  let root = directory,
    common = directory;
  try {
    const { stdout } = await exec(
      "git",
      ["-C", directory, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      { timeout: 2000, env: { ...process.env, LC_ALL: "C" } },
    );
    const lines = stdout.trimEnd().split("\n");
    if (lines.length !== 2) throw new Error("Unsupported Git directory name");
    [root, common] = await Promise.all([realpath(lines[0]!), realpath(lines[1]!)]);
  } catch (error) {
    if (!String(error).includes("not a git repository")) throw error;
  }
  return { project: "asc:v1:" + createHash("sha256").update(common).digest("hex"), root, directory };
}

async function prospectivePath(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || file === path.dirname(file)) throw e;
    return path.join(await prospectivePath(path.dirname(file)), path.basename(file));
  }
}

// Linked worktrees share a project but hold different files, so a resource names its working tree too.
export const treeId = (scope: Scope) => createHash("sha256").update(scope.root).digest("hex").slice(0, 8);

async function resource(scope: Scope, file: string) {
  if (!file || /[\x00-\x1f]/.test(file)) throw new Error("Invalid path");
  const absolute = await prospectivePath(path.resolve(scope.directory, file));
  const relative = path.relative(scope.root, absolute);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Path outside this checkout");
  }
  return { key: `file:${relative.normalize("NFC").toLowerCase()}@${treeId(scope)}`, absolute };
}

export async function fileResources(scope: Scope, files: readonly string[]): Promise<string[]> {
  if (!files.length || files.length > 256) throw new Error("Expected 1–256 file paths");
  const resources = await Promise.all(files.map((file) => resource(scope, file)));
  for (const { key, absolute } of resources) {
    const info = await stat(absolute).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (info?.isDirectory()) {
      throw new Error(
        `Claim individual files; a directory is not reserved: ${key.slice(5, key.lastIndexOf("@"))}`,
      );
    }
  }
  return [...new Set(resources.map((r) => r.key))];
}

export async function editResources(scope: Scope, files: readonly string[]) {
  const results = await Promise.allSettled(files.map((file) => resource(scope, file)));
  return {
    paths: [...new Set(results.flatMap((r) => (r.status === "fulfilled" ? [r.value.key] : [])))],
    incomplete: results.some((r) => r.status === "rejected") || !results.length,
  };
}

export function isBuild(command: string): boolean {
  if (/[;&|`$<>\n]/.test(command)) return false;
  return /^\s*(?:(?:\.\/)?(?:gradlew?|mvnw?)(?:\s|$)|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|test)(?:\s|$))/.test(
    command,
  );
}

// Redirects, in-place editors and commands that create, replace or remove files. Output discarded to /dev/null
// and descriptor duplication (2>&1) do not count.
export function mayWrite(command: string): boolean {
  if (isBuild(command)) return false;
  const rest = command.replace(/>>?\s*\/dev\/null/g, "").replace(/\d*>&\d*/g, "");
  return (
    />>?/.test(rest) ||
    /\b(?:touch|mkdir|tee|truncate|ln)\b|\bdd\b[^|]*\bof=/.test(rest) ||
    /\b(?:sed\s+(?:-\w*i|--in-place)|perl\s+-\w*i)\b/.test(rest) ||
    /\bgit\s+(?:apply|checkout|pull|merge|rebase|stash|restore|reset|clean|switch|cherry-pick|revert)\b/.test(
      rest,
    ) ||
    /\b(?:npm|pnpm|yarn)\s+(?:i|install|add|create|init|update|ci|uninstall|remove|link)\b|\bnpx\b|\bpnpm\s+dlx\b/.test(
      rest,
    ) ||
    /\b(?:rm|mv|cp)\s/.test(rest)
  );
}
