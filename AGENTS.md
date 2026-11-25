# Agent Instructions — agents-shared-context

An OpenCode server plugin that lets independent sessions in one local project see each other, reserve files and builds, wait, or request exclusivity. TypeScript plugin, one Lua script, Redis 7.4+. Public repository, MIT.

## Read before touching an area

| Area                                                                        | Read                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Any behaviour                                                               | `openspec/specs/session-coordination/spec.md` (normative), then `README.md` (user-facing wording) |
| Tests, choosing a check, a red run                                          | skill `asc-testing`; on a confusing failure also its `references/failure-playbook.md`             |
| Writing or changing a live-model scenario                                   | `asc-testing/references/live-model-findings.md` and skill `opencode-live-sessions`                |
| `src/`, hooks, Lua, packaging, README or spec edits, review before a commit | skill `asc-development` and its `references/opencode-and-redis-facts.md`                          |
| Starting real sessions from a script                                        | skill `opencode-live-sessions`                                                                    |

## Commands

```sh
npm ci --ignore-scripts
npm test                                   # tsc + unit/integration; needs Redis 7.4+ at REDIS_URL
npm run test:managed                       # Docker
npm run test:acceptance                    # packed plugin in real OpenCode; needs `opencode` and Redis
ASC_INSTALL=global-managed npm run test:acceptance
node test/live.mjs                         # real model; costs tokens; see asc-testing
npm run format:check
npm run check:public                       # no local paths, internal hosts or credentials
openspec validate --all --strict
```

## Rules

- A behaviour change ships with an OpenSpec change in the same task, and the README sentence it makes untrue is fixed in the same task. Archive the change when done.
- Prove a Lua or wiring change with a test that failed first. A green suite is not evidence for a change that only a real session can show: add or extend a scenario.
- Before a commit, review the change twice on the same files and merge the findings: OCR in delegation mode (`ocr delegate preview`, then `ocr delegate rule`), then the `ponytail-review` skill. The steps are in skill `asc-development`.
- Never commit or push unless the user asks in this conversation. Report the branch and offer.
- Do not start live-model runs or subagents without the user's choice of model.
- Verify on the user's own machine (macOS) by default. Run checks in a Linux container only when the change is Linux-specific, when CI failed on Linux, or when the user asks. Say which platform a result was observed on.
- Leave no Docker containers, no OpenCode sessions and no temporary directories behind. Check `docker ps -a` for `agents-shared-context-*` after the managed tests and after any subagent that ran tests.
- No absolute paths, internal hostnames or credentials in any tracked file. Do not quote a forbidden literal in prose either; describe it in words.

## Keep the skills current

The skills under `.agents/skills/` are this repository's memory. A fresh agent knows nothing about this session; what is not written there will be stepped on again.

In the same task, without being asked, update them when any of these happens:

- Something took more than one attempt, or a first theory was wrong. Record the symptom, the actual cause and the guard, in the matching skill. Put a repeated class of failures in `asc-testing/references/failure-playbook.md` as one table row.
- A live run showed how a model reacts to a tool, a refusal or a system text. Add it to `asc-testing/references/live-model-findings.md`.
- A fact about OpenCode, its CLI or Redis was verified or turned out different from what the facts file says. Correct `asc-development/references/opencode-and-redis-facts.md` and name the version it was observed on.
- A new invariant, a new test layer, a new command or a new scenario was added. The module map, the layers table and the commands above must stay true.
- A subagent or a fresh agent misunderstood an instruction, or could not answer a question from the skills. Fix the wording or add the missing piece.

Write for a reader with a clean context: what happens, why, the exact command or file, and the evidence that established it. No session narratives. A skill stays under about 150 lines; longer material goes into a `references/` file that the skill links.

A new or changed skill is verified before it is called done: a fresh agent on the model the user names answers questions that the skill covers and runs a command the skill prescribes, without the mistakes the skill warns about. A failure there is a gap in the skill; fix it and verify again.
