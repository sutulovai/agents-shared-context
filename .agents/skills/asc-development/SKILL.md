---
name: asc-development
description: Use when changing TypeScript or Lua under src/, wiring or reordering OpenCode hooks and tools, changing the Redis data layout, packaging the plugin, reviewing a change before a commit, or updating the README or OpenSpec in the agents-shared-context repo. Gives the module map, the invariants a change must keep, the order of a change, the review steps before a commit, and points at the verified OpenCode 2.3.2 behaviours and at every mistake that already happened here.
---

# Developing the plugin

Read [references/opencode-and-redis-facts.md](references/opencode-and-redis-facts.md) before touching a hook, the Lua script, or anything that depends on how OpenCode reports a session. It lists what was verified on OpenCode `2.3.2` and Redis `7.4`, and the wrong assumption each entry replaced. For a red test, read skill `asc-testing` and its failure playbook first.

## Module map

| File                | Responsibility                                                           | Depends on                  |
| ------------------- | ------------------------------------------------------------------------ | --------------------------- |
| `src/store.ts`      | One Lua script. All shared state and every rule about who may hold what. | Redis 7.4 hash field expiry |
| `src/resources.ts`  | Project identity, path normalization, build and shell-write classifiers. | Nothing in the plugin       |
| `src/connection.ts` | Redis connection with bounded waits; managed container lifecycle.        | Docker CLI                  |
| `src/index.ts`      | Hooks, tools, commands, session membership, warnings.                    | All of the above            |

Rules live in Lua when two sessions can race for them. Rules live in TypeScript only when they concern one session's own bookkeeping.

## Invariants

- **Fail open, never lie.** When Redis cannot answer, the edit proceeds with a visible warning. `coord_who` reports unavailability instead of an empty project. An OpenCode `deny` is never upgraded to `allow`.
- **One atomic decision.** A claim checks every peer and writes in the same Lua invocation. There is no read-then-write across two calls and no key scan outside the project hash.
- **Ownership is a token.** Renewal and release are refused when the token differs. A new plugin instance with the same session ID gets `occupied`, not the lease.
- **Native edits are provisional.** A claim taken for a tool call exists until that call finishes. Rejection or failure abandons only that call's claim.
- **Parallel needs both sides.** A newcomer's choice cannot override a veto. Exclusive `work` mode outranks earlier file claims because their owners are read-only meanwhile.
- **A grant must be usable.** A session told "exclusive" must be able to edit; a tool called "wait" must actually wait. A live model lost trust in both when they did not, and went looking for a way around the plugin.
- **Nothing is stored that is not needed for coordination.** Session IDs, titles, relative paths, tokens, a short reason. No prompts, diffs or credentials.
- **Bounds everywhere.** 128 sessions per project, 256 paths per session, 32 concurrent provisional calls, 160 characters for a reason. Each has a visible status (`full`), never a silent drop.
- **A file belongs to one working tree.** Linked worktrees share a project but not files: a file resource carries a hash of its working tree. Builds and exclusivity stay project-wide.
- **Memory defers to Redis.** A veto, membership or claim that Redis no longer holds is gone. The next operation rejoins from ordinary admission instead of refusing with `lost`.
- **No phantom in-flight work.** A finished tool call whose provisional claim was not acknowledged is settled on the next successful operation, or every exclusivity request stays pending.
- **Text from other sessions is data.** Titles and reasons are written by other agents and reach this session's model. The system text tells the model to treat them as information.
- **Notices are one sentence.** A denial or warning names the peer by label, never by session ID, and states the choice or fix once. The owner rejected multi-sentence coordination prompts as machine-facing noise.

## Order of a change

1. Write the behaviour as an OpenSpec change (`openspec new change <name>`), with a failing test at the lowest layer that can express it.
2. For a Lua change: extend the `Operation` union in `src/store.ts`, then the script. See the argument layout below.
3. For wiring: extend the `fixture(t)` fake context in `test/child.test.mjs` only with methods the plugin really calls.
4. Run `npm test`, the acceptance suite, and the managed suite when `src/connection.ts` changed. Add or extend a live scenario when the change concerns what a model will see or decide.
5. Update the README sentence the change made untrue. Then review the change (next section).
6. `openspec archive <name> --yes`, then `openspec validate --all --strict`. List the new archive directory: it must contain `.openspec.yaml` and `README.md`. A requirement text over 500 characters fails strict validation; state one behaviour per requirement and put details in scenarios.
   A `MODIFIED` block replaces the whole requirement: copy every existing scenario into it and add the new ones, or the archive stops with "scenario(s) not present in the modified block". A new requirement header placed above existing scenarios takes those scenarios with it; check which requirement each scenario sits under after an edit.

## Review before a commit

The owner's standing rule: every change is reviewed through two passes on the same diff, and the findings are merged into one list.

1. **OCR in delegation mode.** The skill file lives in another repository on this machine, so it may not load here; follow its steps directly. `ocr delegate preview --format json` lists the reviewable files and the excluded ones. `ocr delegate rule --format json <paths…>` returns the rule checklist. Read every reviewable file against that checklist and account for each file as reviewed or skipped with a reason. This repository has no `.opencodereview/rule.json`, so the system rules apply. They forbid nested ternaries, `var`, loose equality and `any`; a chain of `? :` in `describe()` and in the acceptance harness was the first finding.
2. **`ponytail-review`** on the same files: bugs, risks, scale, missing tests, speed, lean.
3. An independent reviewer on a capable model is worth its cost for this code. Give it the spec path and the owner's deliberate decisions, or it will report those decisions as defects. Restrict it to reading. It may still run things: check `docker ps -a` and for stray `opencode` processes while and after it runs, and look at container creation times before blaming it for anything.

Report findings merged, most severe first, each with file:line, the case that triggers it and the smallest fix.

## Lua argument layout

`change()` passes positional arguments to the script. Adding one means shifting every index after it.

```
ARGV 1..5   op, id, token, label, ttl
ARGV 6      call id (message:id) for provisional claims and veto requests
ARGV 7      policy mode
ARGV 8      policy reason
ARGV 9      expected veto request for a build that requires stable sources
ARGV 10..   paths
```

Operations that compare against peers are listed in one `if` before the `HGETALL`. A new read-only operation must also return before the `HSET` at the end; `probe` shows the pattern. Every return path after a write must leave `pending`, `kept`, `policy` and `build:checkout` in a state that matches what the caller will do next.

## Things that broke before

Plugin:

- Two sessions creating the managed container at once: the second `inspect` ran before Docker made the container visible. The loop retries `no such container` a few times before giving up.
- A session that ended while another operation was still resolving its member record. `end()` is serialized through the `ending` map, and a new member record waits for it.
- `session.idle` arriving for a session that had already started new work. The handler re-reads session time and ignores the event when `idle` is older than `busy`.
- A cancelled `coord_wait` ending a session that was already an active participant. It now ends membership only for sessions that had not been admitted.
- The event stream ending without an abort. Renewal keeps running on its timer and falls back to the host's session status.
- An outage notice left in a session's instructions after Redis came back, when the session only ever waited. `recovered()` now runs on every successful admission and reservation.
- `coord_wait` was a no-op for a parallel session, and exclusive `work` mode was still blocked by earlier claims. Both were found by live models, not by tests.
- Found by an independent reviewer, each with a test now: a stale in-memory veto blocked its own owner after a lease loss; two linked worktrees conflicted on same-named files; a claim on a directory reserved nothing; a session without a Redis record was told "another session is active" when it asked for exclusivity; a once-per-session notice was spent on a failed command; `coord_who` printed `[]` for a session that had left.
- A model that distrusts a quiet command reruns it. The tool result of a finished stable build states that source protection ended, so a rerun asks for it again.
- The unused `drop` operation was removed from the Lua script and the `Operation` union together. An operation with no caller in `src/index.ts` is dead code.

Working in the repository as an agent:

- The harness built its plugin options in one refactor with `managed` inverted. Outage scenarios hid it. Guards in `test/acceptance.mjs` now fail on the first container.
- A review by the author misses the author's assumptions. The inverted flag, the port-1 assumption and the `PWD` problem were each found by looking at evidence from outside the code: a config file, a container list, a `redis-cli MONITOR` log.
- Tool slips that cost a round each: an edit that inserted a literal `+` line into a YAML file; a shell redirect placed before the directory it writes into exists; a `mkdir -p` that stopped one level short. Re-read the file after a mechanical edit.
- `openspec new change` can report "already exists" after creating the directory. Write the artifacts into the directory it names and check the result after archiving.
- Changing a plugin default broke a unit assertion that encoded the old mode's semantics (an observer got patch tools only under `join: "ask"`). When changing a default, grep test assertions that branch on the mode, not only README and message strings.
- A skill that quotes a forbidden literal, such as a home-directory prefix, fails the public-tree scan. Describe patterns in words.

## Packaging and the public repository

The package is public and pinned to one OpenCode version.

- `peerDependencies["@opencode/plugin"]` is the version every check ran against. Changing it means re-running every layer.
- `test/suite.mjs` asserts the exact file list of the packed tarball. A new file under `dist/` must be added there, or the suite fails at the allowlist.
- The consumer install in the suite runs with `--ignore-scripts`. So does `npm ci`. Nothing in this package needs an install script.
- Before proposing a commit, run `npm run check:public`. It fails on home-directory paths, internal hostnames, key patterns, access tokens and live session identifiers in any tracked or untracked file.
- Never commit or push without an explicit request in the conversation. Report the branch and offer.
- CI runs on Linux with Node 22. Local verification was on macOS arm64 only. Say so when reporting; do not call a platform verified that was not exercised.

## Platform

The owner runs macOS, and that is where results count. Run checks in a Linux container only when the change is Linux-specific, when CI failed on Linux, or when the owner asks. One such run cost an hour and proved nothing: it replaced `node_modules` with Linux binaries and had to be redone on macOS. Say which platform a result was observed on.
