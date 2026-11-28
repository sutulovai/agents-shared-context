# Design

## Decisions

- **Retry the existing atomic `claim` operation from a blocking tool loop; no new Lua operation.** Each retry is one Redis invocation that probes and reserves atomically, so the winner of a wake race is decided inside Redis. This keeps "one atomic decision" intact and avoids new store states. The loop mirrors `coord_wait`'s 1.5 s `delay` loop, `AbortSignal.any` cancellation, `progress` updates on blocker change, and the `recovered()`/outage handling.
- **`wait` is opt-in per call, default false.** Immediate mode is unchanged byte-for-byte; every existing test and live behavior keeps holding. The docs and the `coord_who` guidance sentence steer models toward `wait: true` — models under stress never set parameters unprompted, so the guidance and README wording must name the flag explicitly.
- **The pending call holds no claim.** Until an attempt succeeds, nothing is reserved — a cancelled wait leaves the project exactly as it found it. On success, the claim is an ordinary lease: renewed by the heartbeat, released by cancel/expiry.
- **Progress is the notification channel.** Blocker name and changes surface through tool progress, as `coord_wait` does today; the terminal result states the reservation. No system-prompt injection.
- **Policy interplay.** A read-only project (incumbent veto) surfaces in progress; admission changes are re-evaluated by `enter()` inside the loop, matching `coord_wait`'s behavior.
- **`coord_wait` stays as-is.** Its path probing remains for sessions that only want to wait; docs demote it in favor of `claim { wait: true }`. Removing it would churn the tool surface for no behavioral gain.

## Test plan

- Wiring (`test/child.test.mjs`): pending behavior against a held path, winner-takes-it race with a peer release, immediate mode unchanged, cancellation reserves nothing, veto surfaced in progress.
- Acceptance (`test/acceptance.mjs`): scripted-model scenario — model calls `coord_claim { wait: true }` on a path another session holds; holder session releases; waiter's claim succeeds without any further model step.
- Live (`test/live.mjs`, optional, model `gpustack/glm-5.3-flash` per user): does a real model find and stay inside a blocking claim instead of polling.
- No `test/store.test.mjs` change expected; if the implementation reaches for Lua, stop and report instead of extending the store silently.
