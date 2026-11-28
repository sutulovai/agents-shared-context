# Proposal

## Why

Live sessions blocked on held files fall into a `coord_who` poll loop: the tool returns the same answer every time, the model keeps calling it (77 calls observed in one session), and tokens burn while nothing changes. The blocking alternative, `coord_wait`, already exists but the model does not reach for it on its own.

## What Changes

- `coord_who` detects three consecutive identical answers within one membership and appends one sentence of guidance to the result: the project state is not changing by itself; call `coord_wait` to block until it does, or ask the user to enter `/coord-wait` or `/coord-parallel` when tools are restricted.
- A changed answer resets the counter. The guidance never changes admission, claims, or tool availability.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `session-coordination`: a new requirement under the `coord_who` reporting behaviour — repeated identical project reports gain waiting guidance in the tool result.

## Impact

- `src/index.ts` (`coord_who` tool execute, `Member` record).
- `test/child.test.mjs` (plugin wiring test).
- `README.md` (one sentence in the `coord_who` description).
