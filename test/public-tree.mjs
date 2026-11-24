// A public repository must not carry local paths, internal hosts, live identifiers or credentials.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  .toString()
  .split("\0")
  .filter(Boolean);
const rules = [
  ["home directory path", /\/Users\/[A-Za-z]|\/home\/[a-z]+(?=\/)/],
  ["work or internal hostname", /\.(?:lmru\.tech|sutulovai\.local)\b/i],
  ["private key block", /BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY/],
  ["access token", /\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{20,})\b/],
  ["live session identifier", /\bses_[A-Za-z0-9]{20,}\b/],
];
const hits = [];
for (const file of tracked) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    continue;
  }
  for (const [name, pattern] of rules) {
    const match = pattern.exec(text);
    if (match) hits.push(`${file}: ${name} ("${match[0].slice(0, 48)}")`);
  }
}
console.log(`Public tree scan: ${tracked.length} files, ${hits.length} matches.`);
for (const hit of hits) console.log("  " + hit);
process.exit(hits.length ? 1 : 0);
