import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { locate, fileResources, isBuild, mayWrite } from "../dist/resources.js";

test("only commands that can change files on disk trigger the coordination notice", () => {
  for (const cmd of [
    "echo x >> out.txt",
    "echo y > other.txt",
    "sed -i s/a/b/ f.txt",
    "ls | tee list.txt",
    "mv a b",
    "cp a b",
  ])
    assert.equal(mayWrite(cmd), true, cmd);
  for (const cmd of ["ls -la", "cat f.txt 2>/dev/null", "./gradlew test", "git diff --stat >/dev/null"])
    assert.equal(mayWrite(cmd), false, cmd);
});

test("nested checkouts and symlinked new files use the same resource; external paths are rejected", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asc-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  await mkdir(path.join(root, "src"));
  await symlink("src", path.join(root, "alias"));
  const whole = await locate(root);
  const nested = await locate(path.join(root, "src"));
  assert.equal(whole.project, nested.project);
  assert.deepEqual(await fileResources(whole, ["alias/new.txt"]), await fileResources(nested, ["new.txt"]));
  await assert.rejects(fileResources(whole, ["../escape"]));
  await assert.rejects(fileResources(whole, ["src"]), /director/i);
});
test("only documented simple foreground build commands are detected", () => {
  for (const cmd of ["./gradlew test", "npm run build", "mvn verify"]) assert.equal(isBuild(cmd), true, cmd);
  for (const cmd of ["cat build.gradle", "npm view build", "npm run build &", "echo ./gradlew"])
    assert.equal(isBuild(cmd), false, cmd);
});

test("linked worktrees share the project, independent clones do not", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asc-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = path.join(root, "main"),
    linked = path.join(root, "linked"),
    clone = path.join(root, "clone");
  execFileSync("git", ["init", "--quiet", main]);
  execFileSync("git", [
    "-C",
    main,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  execFileSync("git", ["-C", main, "worktree", "add", "--quiet", "--detach", linked]);
  execFileSync("git", ["clone", "--quiet", main, clone]);
  const inMain = await locate(main);
  const inLinked = await locate(linked);
  const inClone = await locate(clone);
  assert.equal(inMain.project, inLinked.project);
  assert.notEqual(inMain.project, inClone.project);
  // Same project, different working trees: the same relative name is a different file.
  assert.notDeepEqual(await fileResources(inMain, ["src/a.ts"]), await fileResources(inLinked, ["src/a.ts"]));
  assert.deepEqual(await fileResources(inMain, ["src/a.ts"]), await fileResources(inMain, ["./src/a.ts"]));
});

test("shell commands that create, replace or remove files are recognised", () => {
  for (const cmd of [
    "touch a.txt",
    "mkdir -p out",
    "git checkout main",
    "git pull",
    "npm install",
    "npx prettier --write .",
    "perl -pi -e s/a/b/ f.txt",
    "sed --in-place s/a/b/ f.txt",
    "dd if=/dev/zero of=b.bin",
    "echo x 2> err.log",
    "echo x &> all.log",
    "echo x 1> out.log",
  ])
    assert.equal(mayWrite(cmd), true, cmd);
  for (const cmd of [
    "ls -la",
    "cat f.txt 2>/dev/null",
    "./gradlew test",
    "git diff --stat >/dev/null",
    "echo done 2>&1",
    "git status",
  ])
    assert.equal(mayWrite(cmd), false, cmd);
});
