# Failure playbook

Symptoms met in this repository, what each one actually was, and the guard that now exists. Read the whole row before acting: most false failures were caused by the test or the environment, not by the plugin.

## Harness and environment

| Symptom                                                                            | Actual cause                                                                                                     | Guard or action                                                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm test` reports 13 failures with connection errors                              | No Redis listening on the default port                                                                           | `test/require-redis.mjs` refuses to start and prints the container command             |
| Every Redis test fails inside a Linux container although `REDIS_URL` is right      | The plugin connects to `127.0.0.1` only; Redis was on another host                                               | Share the network namespace of the Redis container                                     |
| Outage scenario passes or fails depending on the time of day                       | Port 1 was assumed closed. A leftover container was bound to it                                                  | Local server that resets connections; container-list assertion                         |
| `recover` fails with "Owner holds no live claim"                                   | The harness built the config with `managed: true`, so the plugin tried Docker instead of the test Redis          | Container-list assertion; config printed in the failure message                        |
| Twenty `agents-shared-context-<port>` containers exist                             | Each failed run with the inverted flag created one; cleanups never ran                                           | Remove them; the list assertion now fails on the first one                             |
| A test left a container behind                                                     | The failure happened before `t.after` was registered                                                             | Register cleanup first; check `docker ps -a` after every run                           |
| A session "wrote anyway" in a live run                                             | The owner session had finished, the project was free, and the peer legitimately had full tools                   | Give the owner more steps than the peer needs                                          |
| Live test wrote its fixture into the plugin repository                             | `opencode run` takes the directory from `$PWD`, and the child inherited the parent session's `OPENCODE*` context | Set `PWD` in the child environment and strip `OPENCODE*`/`CMUX*`                       |
| Live sessions landed in the wrong directory or attached to the agent's own session | Same as above                                                                                                    | Same as above; see skill `opencode-live-sessions`                                      |
| A scenario times out at random                                                     | Another agent was running Docker-heavy tests on the same machine                                                 | Check for foreign containers and `opencode` processes; rerun when the machine is quiet |
| macOS test run fails right after a Linux run                                       | `npm ci` inside the Linux container replaced `node_modules`                                                      | `npm ci --ignore-scripts` on macOS                                                     |
| A notice appended to a tool result is missing                                      | `result.content` was an array of parts, not a string                                                             | Handle both shapes                                                                     |

| Every test that calls a helper fails with `ReferenceError` | The helper was a `const` declared after the tests | Declare helpers above the first `test()` |
| A test deletes Redis state and nothing changes | The fixture had lost the field that holds the project key, so it deleted `undefined` | Print the value inside the assertion before trusting it |
| The test process stays alive for a minute after the last test | The unload hook waited on an already-resolved promise and never unloaded the plugin; its Redis connection stayed open | One unload function per fixture, shared by the test and the hook |
| Assertions fail after a key-format change | Tests compared whole resource keys | Compare paths with the tree suffix removed |
| An exclusivity test reports "Another session is active" | The second session was a top-level one and was waiting for the user's choice | Use the `child` session for an admitted parallel peer |
| An id suffix does not match `[0-9a-f]{6}` | Session IDs are base-62, not hexadecimal | `[A-Za-z0-9]{6}` |
| Every live scenario fails at once, including one that passed a minute ago | A shell command recreated the Redis container but kept the old port variable | Take the port from the container after starting it, in the same command |
| `ASC_INSTALL=global-managed npm run test:acceptance` stops with "No Redis is listening" | The Redis precheck ran for the one mode that needs no external Redis | The suite skips the precheck for that mode |
| A new scenario passes alone and fails in the suite, or the reverse | Another run left a container on the port the scenario assumed free | Reset-fixture assertions; check `docker ps -a` before judging |

## Model behaviour in live runs

Live assertions must accept any reasonable tool path a model may take. A check for `Edited shared.txt` failed when the model rewrote the file with `write`; a check for exactly one build failed when a suspicious model reran the command three times. Assert the protection the plugin gave (a refusal the neighbour received, ordering of writes, a tool the model called), and record counts as evidence.

| Symptom                                                      | Actual cause                                                                                                             | Guard or action                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| The model did not ask the user the expected question         | The prompt said "Do not ask questions; this run has no person to answer"                                                 | Omit that sentence for scenarios that expect a question                              |
| The owner stops after its first edit with "Edit rejected"    | The model called `edit` with an empty `oldString`, a tool validation error, and the prompt said to stop on any rejection | Create the file beforehand; tell the model to stop only on `Conflict` or `Read-only` |
| The peer timed out                                           | The owner had more steps than the peer's wait window                                                                     | Scale steps per scenario: `gate` 120, `conflict` 40, `stable-build` 200              |
| The first peer edit fails with "Could not find oldString"    | The model composed an edit against a file the owner was still changing                                                   | Assert ordering of successful writes, not the error of the first attempt             |
| The model reports "appended" without calling the edit tool   | Model quality (`glm-5.3-flash` on a multi-step task)                                                                     | Rerun on a stronger model; name the model in the report                              |
| The owner loops on `read` for minutes                        | Its edit was denied with `Read-only` and the prompt told it to keep going                                                | Treat as a busy owner; it is a realistic neighbour, not a plugin fault               |
| The peer reached for a shell redirect to write the held file | It was frustrated by a `coord_wait` that returned at once and an exclusivity that still denied edits                     | Both plugin defects were fixed; the shell notice now marks uncoordinated writes      |

## Plugin defects that only live runs found

| Defect                                                                                          | Visible as                                                  | Fix                                                      |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| `coord_wait` returned "Project available" immediately for a session already working in parallel | Model called it twice, then tried exclusivity               | `probe` operation; `coord_wait` waits for held paths     |
| Exclusive `work` mode still denied edits on files other sessions had claimed                    | "Project exclusive" followed by `Conflict` on the same file | Exclusive holder overrides earlier claims                |
| Shell redirects were invisible to coordination                                                  | Model wrote the held file with `>>`                         | Once-per-session notice on commands that may write files |
| Refusals named the owner by an internal session id                                              | `held by ses_…`                                             | Messages carry the session title                         |

## Working with the spec and the repository

| Symptom                                                   | Actual cause                                                                       | Guard or action                                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `openspec validate --strict` fails after archiving        | A requirement text exceeded 500 characters                                         | One behaviour per requirement; details in scenarios        |
| An archived change lacks `.openspec.yaml` and `README.md` | `openspec new change` reported "already exists" and the files were written by hand | List the archive directory after archiving; add both files |
| `npm run check:public` fails on a skill                   | The skill quoted the literal pattern it described, for example `/Users/`           | Describe the pattern in words                              |
| The acceptance suite fails at the file allowlist          | A new file under `dist/`                                                           | Add it to the list in `test/suite.mjs`                     |
| A review tool flags nested ternaries                      | Chains of `? :` in `describe()` and in harness option building                     | Use `if` statements                                        |
