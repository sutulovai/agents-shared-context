---
name: opencode-live-sessions
description: Use when a script or a nested agent must start real OpenCode sessions from the terminal, such as live-model tests, reproducers, or checks of how an agent behaves with a plugin or skill. Covers the environment that makes a session land in the wrong directory, the flags of opencode run, reading its JSON events, tracing what the host gave the model, deciding whether a failure belongs to the plugin, the prompt or the model, and cleaning up sessions, containers and temporary files afterwards.
---

# Driving real OpenCode sessions from a script

A live session is the only check that shows how an agent behaves. It costs tokens and it touches the user's real OpenCode service, so ask which model to use before the first run and delete every session afterwards.

Facts below were verified on OpenCode `2.3.2`.

## The session directory comes from the environment

`opencode run` does not take the working directory from the process. It uses the environment variable `PWD`. A child started with `cwd` set to a throwaway project and `PWD` left unchanged edits whatever directory the parent was in. That is how a test once wrote its fixture into the plugin's own repository.

When the script itself runs inside an OpenCode session, the inherited `OPENCODE*` variables attach the child to the parent's context and `CMUX*` wrappers can redirect it. Remove both prefixes.

```js
import { spawn } from "node:child_process";

const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE|CMUX)/.test(name)));
const child = spawn(
  "opencode",
  ["run", "--auto", "--archived", "--format", "json", "-m", model, "--title", title, prompt],
  { cwd: project, env: { ...env, PWD: project }, stdio: ["ignore", "pipe", "pipe"] },
);
```

In a shell, `cd` into the project first so that `PWD` is right. The first symptom of a wrong directory is a model that reads a file which "already exists" in a project you just created.

## Flags

| Flag             | Effect                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `--standalone`   | Private server. No access to the user's configured providers. Use it with a scripted model endpoint.            |
| `--server <url>` | A private server started with `opencode serve --hostname 127.0.0.1 --port <n>`; set `OPENCODE_PASSWORD` for it. |
| neither          | The shared background service, with the user's providers and global configuration.                              |
| `--auto`         | Approves permissions that are not explicitly denied. An explicit `deny` rule still applies.                     |
| `--archived`     | Keeps the session out of the session list. Use it for test sessions.                                            |
| `--format json`  | One event per line on stdout.                                                                                   |

Pass a prompt that expects an interactive user only when a person can answer. `Do not ask questions` makes a model bypass a gate that works by asking, and the run then looks like a plugin defect. Prompts for a helper session should say what to stop on: "stop only when an error contains `Conflict` or `Read-only`", not "stop on any rejection", because a tool's own validation error is also a rejection.

## Reading events

Each line is an object with `type`, `sessionID`, `timestamp` and `part`. Useful types:

- `tool_use`: `part.tool`, `part.state.status` (`completed` or `error`), `part.state.output`, `part.state.error`, `part.state.input`.
- `text`: `part.text`.
- `step_finish`: one per model step, with token usage.

Record `sessionID` from the first event. Keep events in arrival order; a transcript that lists texts first and tools second misrepresents what the model knew when it acted.

```js
const transcript = (states) =>
  states
    .flatMap((s) => s.events)
    .sort((x, y) => x.timestamp - y.timestamp)
    .flatMap((e) =>
      e.type === "text"
        ? [`TEXT ${e.sessionID.slice(-6)}: ${e.part.text.slice(0, 260)}`]
        : e.type === "tool_use"
          ? [
              `TOOL ${e.sessionID.slice(-6)} ${e.part.tool} [${e.part.state.status}]: ${String(e.part.state.output ?? e.part.state.error ?? "").slice(0, 260)}`,
            ]
          : [],
    )
    .join("\n");
```

## Tracing what the host gave the model

A model can only use the tools the host offered it. To see them, add a small probe plugin after the plugin under test. Project-level plugins load from a path listed in `opencode.json`.

```ts
import { appendFileSync } from "node:fs";
export default {
  id: "trace",
  async setup(ctx) {
    await ctx.session.hook("context", (e) =>
      appendFileSync(
        "/tmp/trace.log",
        `CONTEXT ${e.sessionID.slice(-6)} ${Object.keys(e.tools).sort().join(",")}\n`,
      ),
    );
    await ctx.tool.hook("execute.before", (e) =>
      appendFileSync("/tmp/trace.log", `BEFORE ${e.sessionID.slice(-6)} ${e.tool}\n`),
    );
  },
};
```

Hooks run in plugin order, so a probe registered later sees the tool list after the plugin under test removed names from `event.tools`. One run of this trace showed a model that had only `coord_who`, and a run without it looked like the model had ignored a gate.

In the user's real configuration the tool list also contains `execute`, which exposes the other tools through a Code Mode catalogue. Removing a tool for a gated session means removing its entry from `event.tools`, `execute` included.

## Cleaning up

A finished session keeps its history in the user's database. Delete each one:

```sh
opencode api delete /api/session/<sessionID>
```

Collect the IDs as events arrive, not only at the end, because a failed run never reaches its last line. Kill child processes in a `finally` block.

Also remove what the run created around the sessions: the throwaway project under `$TMPDIR`, a Redis container started for the run, and any output files. A failed run leaves all of them. Before you report, check `docker ps -a` and `ls -d "$TMPDIR"/<your-prefix>-*`.

## Deciding what a live failure means

Separate four causes before changing anything:

1. **The plugin or skill under test.** The trace shows a tool the gate should have removed, or a state the store should have refused, or a tool that answered "available" while the trace shows the condition was not met.
2. **The script.** The session edited the wrong directory, or the fixture ended before the other session acted. A session that edits after its neighbour finished is correct behaviour.
3. **The prompt.** The instruction contradicts the expected behaviour, or it makes the model stop or loop on something that is not the condition you care about.
4. **The model.** It skips a step and reports it done, or repeats a read for minutes. Confirm by rerunning with a stronger model, and name both models in the report.

Use the evidence in this order: the ordered transcript, the probe trace, the state store (`coord_who` output or a direct query), then the files on disk.

## Keeping a helper session busy

A scenario with two sessions needs the first one to stay active for longer than the second one needs. A loop of single-line edits does that for a predictable time and through the tools the plugin coordinates.

- Create the target file before the run. `edit` cannot create a file, and a model that meets a missing file switches tools or stops.
- State the step count explicitly and one edit call per step. Models otherwise batch.
- Match the count to the scenario: enough for the other session to meet a live claim, few enough that it finishes inside the other session's wait window. A peer that waits longer than its timeout fails the run for no reason.

## Cost control

Each step is one model request with the whole conversation so far. A hundred-step helper session on a large model is more expensive than it looks; use a small model for the helper and the capable model for the session under test when the harness allows it. Stop every child process in a `finally` block, and delete the sessions, because they also count against the user's session list.
