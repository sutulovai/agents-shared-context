# OpenCode and Redis facts verified for this plugin

Each entry was observed on OpenCode `2.3.2` and Redis `7.4` during development. When a new OpenCode version is adopted, re-verify these before trusting the plugin against it.

## Permission evaluation

- Every native file write, through `edit` or through `write`, asks for permission with action `edit`. The `resources` are paths relative to the session directory, even when the session started in a nested module.
- A patch that renames a file reports every affected path in one evaluation: the new files, the source and the destination. Denying that evaluation changes nothing on disk.
- A patch that also targets a path outside the checkout still reports only the in-project paths. Such a path cannot be coordinated; the plugin appends a notice instead of refusing.
- `event.source` is `{ type: "tool", messageID, id }` when the evaluation belongs to a tool call. The pair identifies the call in `execute.after`.
- Hooks run for `allow` and `ask`. A configured `deny` never reaches them, so an existing denial always wins.
- `ctx.permission.assert` is a different mechanism: it resolves the rules again and prompts. This plugin uses the hook, not `assert`.

## Tools and requests

- Tools a model may call are `edit`, `write`, `read`, `glob`, `grep`, `shell`, `question`, `skill`, `subagent`, `webfetch`, `websearch`, `execute` and `experimental_image_generate`, plus plugin tools. A user's configuration can add more.
- `execute` exposes the same tools through a Code Mode catalogue. Deleting a name from `event.tools` in the `context` hook removes it from the model's request; the plugin relies on that to strip write tools.
- The `context` hook runs for every model request in the agent loop, including continuations after a tool call. Each request sees the then-current membership.
- `edit` cannot create a file; `write` can. A live model chooses between them by whether the file exists.

## Tool results and hooks

- Session IDs are base-62 strings such as `ses_…KkYVGq`, not hexadecimal. Take the last six characters with a character class that includes uppercase letters.
- A session title is the `--title` passed to `opencode run`, or the generated title. Two sessions can share one.

- `execute.before` receives `{ tool, sessionID, agent, messageID, id, input }`. Throwing from it refuses the call and the model sees the error text.
- `execute.after` always fires, with `status` `completed` or `error`. `result.content` is a string or an array of parts.
- `shell` input has `command` and an optional `background`. Only a foreground command whose completion the plugin can observe is treated as a build.
- Check the actual `opencode --version` before verifying host-facing behavior. In the packed `join-wait-progress` scenario, OpenCode `2.4.1` exposed live `coord_wait` progress through the session-message API; `2.3.2` showed a running tool without that metadata. Neither result proves TUI or desktop rendering.

## Session lifecycle

- `session.get()` returns `time.created`, `time.updated` and, while relevant, `time.busy` and `time.idle`. A session is idle when `idle` is defined and not older than `busy`.
- The `experimental.idle` hook runs when a session finishes model work with nothing pending. It does not run after an interruption or a failure.
- Public events include `session.idle`, `session.deleted` and `session.status`. `session.idle` can arrive for a session that has already started new work, so the handler re-reads the session time.
- `ctx.event.subscribe({ types, signal })` is an async iterable. Abort it in the plugin cleanup; a stream that ends on its own does not throw.
- A child session has `parentID`. Its model requests run their own `context` hook with the child's session ID.
- `session.instructions.entry.put` and `remove` add and delete a named block in the session's instructions. It is how the plugin keeps an outage visible across turns.

## Configuration and CLI

- A plugin entry is `{ package, options }`. `package` may be a directory path. A project-level `opencode.json` and the global one are merged.
- `opencode run` accepts `--standalone`, `--server`, `--auto`, `--archived`, `--format json`, `-m provider/model` and `--title`. Its JSON output has one event per line with `type`, `sessionID`, `timestamp` and `part`.
- `opencode run` takes the session directory from the environment variable `PWD`, not from the process working directory.
- A nested `opencode` started from inside an OpenCode session inherits `OPENCODE*` variables that attach it to the parent's context. Strip them, and `CMUX*`, from the child environment.
- `opencode serve --hostname 127.0.0.1 --port <n>` starts a private server. Clients then need `OPENCODE_PASSWORD`.
- `opencode api <method> <path>` reaches the shared background service. `DELETE /api/session/{id}` removes a session.

## Redis

- `HPEXPIRE key ttl FIELDS n field` expires one hash field. `HPTTL key FIELDS n field` reads its remaining time. Both need Redis 7.4 or newer; the connection checks `COMMAND INFO HPEXPIRE`.
- A Lua script runs atomically. `HGETALL` of the single project hash is the only scan. It blocks Redis while it runs, which is why the hash is bounded.
- `cjson.encode` writes an empty Lua table as an empty array. Always decode with a shape check on the TypeScript side.
- `ioredis` with `enableOfflineQueue: false` and `retryStrategy: () => null` fails fast instead of queueing commands during an outage. The plugin wants the failure, not a delayed success.
