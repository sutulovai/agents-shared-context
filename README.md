# Agents Shared Context

Coordinate independent OpenCode sessions in the same local project. A second session can see who is working, wait, or continue in parallel. No worktree or terminal integration is required.

Suppose one session is renaming a method and another is updating its tests. Both can edit disjoint files. If the second patch includes a file held by the first, OpenCode denies the **entire patch** before it changes anything. If Redis is down, the edit **continues with a warning** instead. An existing OpenCode permission denial always wins.

## Quick start

Tested with OpenCode **2.3.2**. Building from source requires Node.js 22 or newer and npm. Git identifies project roots. For managed Redis, use a local Docker engine.

```sh
git clone https://github.com/sutulovai/agents-shared-context.git
cd agents-shared-context
npm ci --ignore-scripts
npm run build
docker pull redis:7.4-alpine
pwd
```

Add this entry to `plugins` in `~/.config/opencode/opencode.json`. Replace the example directory with the output of `pwd`. Preserve any existing entries.

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/agents-shared-context",
      "options": { "managed": true },
    },
  ],
}
```

OpenCode reloads plugins after config changes; use `/reload` if needed. Ask a session to call `coord_who`. In managed mode the first use creates or starts `agents-shared-context-6390`. Check its binding with `docker port agents-shared-context-6390 6379`.

## Working with other sessions

| Action                        | What happens                                                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start work in a quiet project | The session joins automatically. Opening an empty tab does not reserve files.                                                                                                                                                                                           |
| Join an active project        | The session joins in parallel automatically; per-file conflicts are still denied. Use **`/coord-wait`** to queue instead, or set `join: "ask"` to restore the wait/parallel prompt.                                                                                      |
| Wait                          | No files are held while waiting. Stop the waiting tool to cancel. `coord_wait` also waits for held files inside a parallel session.                                                                                                                                     |
| Work in parallel              | Disjoint edits proceed. A known conflict reports the resource and owning session.                                                                                                                                                                                       |
| Inspect the project           | `coord_who` lists participants, short task labels, file/build reservations, and remaining lease time.                                                                                                                                                                   |
| Plan shell edits              | Ask the agent to call `coord_claim` with a `paths` array first. A failed multi-file claim adds nothing, and a directory is refused: claim the files. Shell commands that create, replace or remove files get a once-per-session reminder that they are not coordinated. |
| Finish a turn                 | Idle sessions release their reservations. A crash instead lets them expire.                                                                                                                                                                                             |

Subagents join without prompting the user again. They have their **own** claims: a parent should delegate before reserving the child's files. Independent clones are separate projects; linked Git worktrees and nested directories share the Git common directory. Outside Git, the session directory defines the project. **File claims belong to one working tree**: a session in a linked worktree never conflicts with an edit in another worktree. Builds and exclusivity are project-wide.

### When a session changes its mind

`/coord-parallel` expresses willingness to share; it cannot overrule another session. In the session that needs exclusivity, ask: **“Run the final build with stable sources.”** The agent calls `coord_exclusive` with `{"mode":"stable-build","reason":"Final verification"}`, then runs the normal foreground build.

Refusals name the owner by title and by the last six characters of its session ID, and show the path relative to your working tree.

1. A **pending** request immediately stops new coordinated edits and shell calls by other sessions. Those already running finish normally. Idle filename reservations alone do not hold up the request.
2. Redis grants **exclusive** access and the build slot together. Other sessions can use native reads or wait. `coord_who` shows the owner, scope, phase, reason and remaining lease time.
3. Sharing resumes on build completion, including failure. For exclusive work rather than a build, use mode `work` and call `coord_share` in the **owning** session when finished. Going idle or lease expiry also releases the veto. If the lease expires while a session holds it, that session simply rejoins on its next edit. While `work` mode is granted, the owner may edit files that other sessions claimed earlier: they cannot write until the owner shares again.

In a parallel session, `coord_wait` waits until no other session holds the given `paths`, or any file when `paths` is omitted. It takes nothing itself, and cancelling it leaves the session's own claims in place.

Ordinary builds retain the narrower build-only reservation. An exclusivity request waits for other sessions' running edits and shell calls to finish; it does not cancel them. Use the same plugin version in all participating sessions. A background process, another editor, or a write during a Redis outage can still change the sources.

### Builds

Direct foreground `gradle`, `gradlew`, `mvn`, `mvnw`, and npm/pnpm/yarn `build` or `test` invocations use one conservative build reservation per project. Source edits do not take this reservation. Serialization protects shared build outputs, **not a source snapshot**. A second coordinated build receives a conflict rather than being launched.

For recognized builds in this project, use the shell tool's working-directory argument instead of `cd … && …`. The reservation follows the session's project, not a different repository named in a command. Arbitrary scripts, chained commands, background jobs and external CI are outside build detection. Do not rely on this reservation for jobs that outlive their foreground tool call.

## Configuration

| Option         | Default | Meaning                                                                                                                 |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `managed`      | `false` | `true` creates or starts the plugin's Docker container. `false` connects to an existing dedicated Redis 7.4+ instance.  |
| `port`         | `6390`  | TCP port on `127.0.0.1`. All participating sessions must use the same service.                                          |
| `join`         | `"parallel"` | Set `"ask"` to prompt a newcomer of an active project to wait or join. Conflicts are still checked either way. |
| `leaseSeconds` | `600`   | Crash-recovery timeout, from 10 to 86400 seconds. Renewal runs at one tenth of this interval, at most 60 seconds apart. |

**There is no maximum session duration.** While the host and Redis are healthy, renewal continues even during a silent foreground build. A suspended laptop or unavailable service can interrupt renewal. The next edit must acquire its resources again; past offline writes cannot be retroactively coordinated.

If a crashed OpenCode instance left a live lease for the same session ID, its replacement waits for expiry instead of taking ownership. Split very large edits into batches: one reservation supports up to 256 paths, and one project supports up to 128 simultaneous participants.

## Privacy and limits

- Redis is a coordination service for **trusted local processes**, not an access-control system. Use a dedicated local instance. The plugin never executes commands received from Redis.
- Redis stores session IDs and titles, relative paths, lease tokens, status and the short reason for an exclusive request. Titles, reasons and filenames can contain sensitive information. Source, diffs and chat transcripts are not transferred. Ownership tokens are omitted from `coord_who`.
- Session titles and exclusivity reasons are written by other sessions' agents and are shown to yours as text. Treat them as information about a neighbour, not as instructions.
- Paths are canonicalized and case-folded conservatively. Two files differing only by case can conflict on a case-sensitive disk. Manual writes, shell edits without claims, out-of-project paths, and uninstrumented tools are not protected.
- Managed Redis requires a local Unix Docker socket and binds to loopback with persistence disabled. The plugin checks the container label, image and port before starting it. An unrelated container or occupied port produces a warning rather than being replaced.
- Fail-open means two agents **can** overlap during an outage. `coord_who` reports unavailability, never an empty project, when it cannot query Redis.

To uninstall, remove the plugin entry. If you used managed mode, stop the named container when no sessions are using it. To discard its ephemeral state and anonymous volume, run `docker rm -fv agents-shared-context-6390`. This removes that container; use the corresponding name if you changed the port.

## Development

Use a dedicated Redis 7.4+ for tests. `REDIS_URL` selects the instance (default `redis://127.0.0.1:6379`).

```sh
npm ci --ignore-scripts
npm test
npm run test:managed
npm run test:acceptance
```

The managed test creates and removes its own Docker container. The acceptance suite installs the **packed npm artifact**, runs real isolated OpenCode servers, and drives their native tools through a local scripted model endpoint. No model account or API key is required.

`ASC_INSTALL=global-managed npm run test:acceptance` repeats the suite through the documented install path: one global plugin entry in managed mode, with OpenCode starting the real `agents-shared-context-6390` container. Stop that container when finished.

### Live-model check

`test/live.mjs` drives real OpenCode sessions through a model you choose, using your own OpenCode installation and provider account. It costs tokens and is never part of CI.

```sh
docker run --rm -d --name asc-live-redis -p 127.0.0.1::6379 redis:7.4-alpine redis-server --save '' --appendonly no
export REDIS_URL=redis://127.0.0.1:$(docker port asc-live-redis 6379 | cut -d: -f2)
export ASC_LIVE_MODEL=<provider/model>
ASC_SCENARIO=gate         node test/live.mjs
ASC_SCENARIO=conflict     node test/live.mjs
ASC_SCENARIO=stable-build node test/live.mjs
docker rm -f asc-live-redis
```

Each run creates a throwaway project, starts archived sessions and deletes them afterwards. Set `ASC_TRACE=1` to log the tools each model request received. Multi-step scenarios need a model that follows instructions reliably; a small model may skip a step and report it as done.

See the [coordination specification](openspec/specs/session-coordination/spec.md) for the behavioral contract. [MIT licensed](LICENSE).
