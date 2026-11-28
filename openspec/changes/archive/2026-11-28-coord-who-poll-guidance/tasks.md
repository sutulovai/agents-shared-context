# Tasks

## 1. Implementation

- [x] 1.1 Add a poll-streak record to the `Member` type in `src/index.ts` and update it inside the `coord_who` tool execute.
- [x] 1.2 Append the guidance sentence to the `coord_who` result on the third and every later identical answer; reset on any different answer.

## 2. Tests

- [x] 2.1 Add a wiring test in `test/child.test.mjs`: no guidance for the first two identical answers, guidance from the third, reset after a changed answer. Watch it fail before implementing.

## 3. Docs and gates

- [x] 3.1 Add the one-sentence README note where `coord_who` output is described.
- [x] 3.2 Run `npm test` (throwaway Redis container) and `npm run format:check`; then `openspec validate --all --strict`.
- [x] 3.3 Two review passes on the same diff (rule checklist + lean review), findings merged.
- [x] 3.4 Archive the change: `openspec archive coord-who-poll-guidance --yes`.
