---
name: asc-testing
description: Use when adding or changing tests in the agents-shared-context repo, choosing which check proves a change, running the suites, or when a test fails and the cause is not obvious. Covers the five test layers, how to get a Redis for them, what each layer can and cannot show, how to debug a failure with evidence, and the mistakes that previously produced false failures and false passes.
---

# Testing the plugin

Every change is proved at the lowest layer that can fail, then again at the packed-artifact layer. Twice a green suite hid a defect that only a real OpenCode session or a real model showed. Read [references/failure-playbook.md](references/failure-playbook.md) when a run is red and the cause is not visible in the assertion.

## Layers

| Layer                | Command                                              | Needs                       | Proves                                                                                          | Cost                             |
| -------------------- | ---------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------- |
| Unit and integration | `npm test`                                           | Redis 7.4+ at `REDIS_URL`   | Lua operations against real Redis, path handling, plugin wiring through a fake `ctx`            | seconds                          |
| Managed Redis        | `npm run test:managed`                               | Docker                      | Container creation, concurrent start, stopped-container recovery, occupied port                 | seconds                          |
| Acceptance           | `npm run test:acceptance`                            | Redis, `opencode` on `PATH` | The packed plugin inside real OpenCode servers, with a scripted model                           | 2–3 minutes                      |
| Documented install   | `ASC_INSTALL=global-managed npm run test:acceptance` | Docker, no external Redis   | The same, installed through a global config entry; OpenCode starts `agents-shared-context-6390` | 2–3 minutes                      |
| Live model           | `node test/live.mjs`                                 | Redis, a provider account   | How a real model uses the tools                                                                 | tokens, 2–8 minutes per scenario |

`npm test` runs `tsc` first, so a type error fails before any test executes. `npm run format:check`, `npm run check:public` and `openspec validate --all --strict` are CI gates too.

What each layer cannot show:

- Unit tests use a fake `ctx`. They cannot show which tools OpenCode offers, which permission resources it reports, or when it fires an idle event.
- The scripted model does what the scenario says. It cannot show whether a real agent finds `coord_wait`, understands a refusal, or works around a gate. Three real defects survived every scripted scenario and fell only to `test/live.mjs`.
- A live run shows one model's behaviour. A result for one model is not a result for another; name the model in the report.

## Redis for tests

Start a throwaway instance and remove it in the same command. Never point tests at a Redis anyone else uses: tests write coordination hashes keyed by project.

```sh
C=$(docker run --rm -d -p 127.0.0.1::6379 redis:7.4-alpine redis-server --save '' --appendonly no)
P=$(docker port $C 6379 | cut -d: -f2)
REDIS_URL=redis://127.0.0.1:$P npm test
docker rm -f $C
```

The plugin always connects to `127.0.0.1`, so the tests read only the port from `REDIS_URL`. `npm test`, the acceptance suite and `test/live.mjs` refuse to start when nothing listens there and print this command instead of a suite full of connection errors.

To run the suite on another platform, share the Redis container's network namespace (`docker run --network container:<redis>`), because the plugin cannot reach a Redis on another host. Installing dependencies inside a Linux container replaces `node_modules` with Linux binaries; run `npm ci --ignore-scripts` again before the next macOS run.

## Where a new test goes

- **Lua behaviour** (new operation, conflict rule, expiry): `test/store.test.mjs`. Call `change()` directly. Watch the test fail for the expected reason before editing the script.
- **Pure functions** (`isBuild`, `mayWrite`, path normalization): `test/resources.test.mjs`, table-driven with literal expectations.
- **Plugin wiring** (hooks, tool results, warnings): `test/child.test.mjs`. Build a fake `ctx` with `fixture(t)`, then call hooks and tools directly.
- **Something only a real server can show** (permission resources, tools offered per request, idle events): a new scenario in `test/acceptance.mjs`, registered in `test/suite.mjs`.
- **Something only a real model can show** (does the agent find the right tool, does a message stop it): a new scenario in `test/live.mjs`.

The fake `ctx` in `fixture(t)` must keep `session.instructions.entry`. The warning path writes a session instruction there; without the stub, a real failure surfaces as `TypeError` from inside the warning and hides its cause.

What `fixture(t, options)` gives a test, and what tripped tests that ignored it:

- `options` reach the plugin: `fixture(t, { leaseSeconds: 10 })` makes the heartbeat run every second.
- The plugin talks to Redis through a proxy inside the test. `setOnline(false)` imitates an outage; the plugin refuses new connections for two seconds after a failure, so wait about 2.3 seconds before expecting a recovery.
- `directory`, `client` and `project` let a test read or delete Redis state directly. `del(project)` imitates a lease that expired while the laptop slept.
- `cleanup()` unloads the plugin once. A test that calls it must still get the unload from the hook; the hook reuses the same promise.
- A second top-level session waits by default, because admission asks the user. Use the session ID `child` when a test needs a second session that is already admitted in parallel.
- `invoke(tools, name, sessionId, input, signal)` calls a tool. Define helpers before the first `test()` call: a `const` at the end of the file is still uninitialized when tests run, and every test that uses it fails with `ReferenceError`.

Resource keys look like `file:src/a.ts@1a2b3c4d`: the suffix identifies the working tree. A test that compares keys strips the suffix; a test that only needs the path uses `startsWith`. Session IDs are not hexadecimal; match them with `[A-Za-z0-9]{6}`.

## The acceptance harness

`test/acceptance.mjs` starts real OpenCode servers with an isolated `HOME` and `XDG_*` tree, a project-level `opencode.json`, and a local HTTP endpoint that imitates an OpenAI-compatible model. The endpoint returns one scripted tool call per step, so each scenario is deterministic.

Facts about this harness:

- The model-facing tools are `edit` and `write`; on OpenCode 2.4.1 a `patch` tool taking `patchText` also exists and is what the scripted scenarios call. The harness checks that the tool it wants is present and records the available list in `errors` when it is not.
- Use the provider id `openai` with the package `@opencode/ai/providers/openai-compatible`. An arbitrary provider id produced `provider.invalid-output`.
- Pass `--auto` and a unique `OPENCODE_PASSWORD`. An explicit `deny` rule still wins over `--auto`, which is what the `deny` scenario relies on.
- The server binds to a random loopback port. A `serve` process is needed only for scenarios that call `opencode api`.
- Tool result `content` may be a string or an array of parts. Handle both when appending a notice, or the notice is silently dropped for one shape.
- `test/suite.mjs` installs the packed tarball into a throwaway consumer directory and asserts its exact file list. It runs each scenario against that install, not against the source tree.

Pick a scenario name and branch on `ASC_SCENARIO`. Scenarios that inject their own Redis endpoint (`outage`, `recover`, `deny`) are unmanaged-only in `test/suite.mjs`, because they cannot run against the managed install.

Three guards exist because each one caught a real harness defect. Do not remove them:

- **Outage fixture.** The outage scenarios point the plugin at a local server that accepts and resets connections. An earlier version used port 1 and assumed nothing listens there. A leftover Redis container on port 1 turned the "outage" into a working connection.
- **Managed flag.** Every unmanaged run asserts that the list of `agents-shared-context-*` containers is the same at the end as at the start. A refactor once set `managed: true` for unmanaged runs; the outage scenarios still passed, because a managed container on an occupied port also produces a warning, and twenty containers piled up before anyone noticed.
- **Recovery precondition.** The `recover` scenario asserts that the owner really holds a live claim in Redis before it cuts the connection. Without that, a "recovery" that was never coordinated looks like a pass.

`ASC_TRACE=1` writes a small probe plugin into the project that logs each permission evaluation with its action, resources and metadata keys. Use it when you need to know what OpenCode actually asks before an edit.

## The managed tests

Register the cleanup with `t.after` as the first statement that can fail later. Two early runs failed before registering it and left containers running for the rest of the day. After any test run, and after any subagent that was allowed to run tests, check:

```sh
docker ps -a --format '{{.Names}} {{.Status}}' | grep -E 'agents-shared-context|asc-'
```

## Debugging a red run

Work from evidence, in this order. Each step below once replaced a wrong theory.

1. **Read the whole assertion message** and print the values it compared. A message that shows only `false !== true` sends you guessing.
2. **Put the evidence into the assertion.** For a state assertion, include the Redis snapshot and the first tool results in the message. The `recover` failure became obvious the moment the message showed `"managed": true`.
3. **Print the generated `opencode.json`.** The harness builds it from several flags; the config the session really received is the truth, not the code you think wrote it.
4. **Watch Redis.** `docker exec <redis> redis-cli MONITOR` shows whether the plugin under test sent anything at all. An empty log means the plugin never connected, which is a different problem from a wrong answer.
5. **Trace the host.** `ASC_TRACE=1` shows the permission evaluations; the live harness logs the tools each model request received.
6. **Rule out interference.** Another agent or an earlier run on the same machine can bind the port you assumed free, fill Docker with containers, or load the CPU so a session misses its window. Check `docker ps -a`, `pgrep -fl 'opencode (run|serve)'`, and the creation time of anything suspicious (`docker inspect -f '{{.Created}}' <name>`) before you attribute it. One such check showed that containers I blamed on a reviewing subagent were created by my own runs a minute earlier.

Decide from the evidence whether the plugin, the harness, the prompt, or the model is at fault, and fix that one.

## Live-model scenarios

`test/live.mjs` needs `ASC_LIVE_MODEL`, `ASC_SCENARIO` (`gate`, `conflict`, `stable-build`, `blocking-claim`) and `REDIS_URL`. It creates a throwaway Git project, starts archived sessions through the user's real OpenCode service, and deletes them afterwards. Starting sessions correctly is its own topic: read skill `opencode-live-sessions` first. The model-facing behaviours it caught are listed in [references/live-model-findings.md](references/live-model-findings.md).

Ask the user which model to use before the first run. A small model can skip a step and report it as done; rerun a suspicious failure on a stronger model before calling it a plugin defect.

## Before reporting

Run every layer the change can reach and quote the counts. Remove test containers and temporary directories under `$TMPDIR` named `asc-*`. Report live runs with the model id. If a layer was not run, say so instead of implying it passed.
