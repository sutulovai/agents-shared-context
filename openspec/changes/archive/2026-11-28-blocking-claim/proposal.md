# Proposal

## Why

Blocked sessions burn their context in poll loops because coordination is a three-step state machine the model must drive: `coord_who` to inspect, `coord_claim` to acquire, `coord_wait` to block, then re-check and claim again. Every arrow is a place where a model misreads a result, loses the wake-then-claim race (the "not a reservation" gap), or stalls. Live observation: a session repeated identical `coord_who` polls ~77 times until its context was spent.

## What Changes

- `coord_claim` gains an optional `wait` flag (default false, current immediate behavior). With `wait: true`, a claim attempt on paths held by another session does not return a conflict to the model: the tool call stays pending and retries the atomic claim every 1.5 s until it succeeds, the user cancels, or the wait is interrupted. Redis decides each attempt atomically — the existing one-invocation claim already makes the winner race-free; no new Lua operation is needed.
- While pending, the call publishes progress naming the current holder and updates it when the holder changes, exactly as `coord_wait` does today.
- On success the result states the paths are reserved and leased as any claim. Cancellation returns without a claim, as `coord_wait` does.
- `coord_wait` keeps its project-wait role; its per-path waiting stays available but docs now point to `coord_claim { wait: true }` as the race-free way to obtain files.
- The repeated-answer guidance on `coord_who` (change `coord-who-poll-guidance`, same repository state) stays as a safety net for models that inspect instead of waiting.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `session-coordination`: the `coord_claim` requirement gains blocking-with-wait semantics; the "Waiting for held resources" requirement is updated to name `coord_claim { wait: true }` as the way to wait for held files.

## Impact

- `src/index.ts` (`coord_claim` tool execute, shared pending-loop logic with `coord_wait`).
- No Lua change expected (atomicity is already in the `claim` operation); revisit only if the store cannot express a needed reply.
- `test/child.test.mjs` wiring tests; `test/acceptance.mjs` scenario for the packed plugin; optional `test/live.mjs` scenario.
- `README.md` tool table and waiting guidance.
