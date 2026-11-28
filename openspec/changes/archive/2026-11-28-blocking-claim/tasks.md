# Tasks

## 1. Implementation

- [x] 1.1 Add `wait` input to `coord_claim` in `src/index.ts`; immediate path unchanged.
- [x] 1.2 Blocking loop for `wait: true` with 1.5 s retries, atomic claim attempts, progress on holder change, cancellation and outage handling shared with `coord_wait` where extraction is mechanical.

## 2. Tests

- [x] 2.1 Wiring tests in `test/child.test.mjs`: pending on held path, race after release, immediate unchanged, cancel reserves nothing, veto surfaced. Red before implementation.
- [x] 2.2 Acceptance scenario in `test/acceptance.mjs` registered in `test/suite.mjs`.
- [x] 2.3 Optional live scenario in `test/live.mjs` on `gpustack/glm-5.3-flash`; report with model id.

## 3. Docs and gates

- [x] 3.1 README: `coord_claim` row gains the `wait` flag; waiting guidance names it as the race-free path; `coord_wait` row cross-references it.
- [x] 3.2 Full gates: `npm test` (throwaway Redis), `npm run test:managed`, `npm run test:acceptance`, `npm run format:check`, `npm run check:public`, `openspec validate --all --strict`.
- [x] 3.3 Two review passes on the same diff (rule checklist + lean review), findings merged and fixed.
- [x] 3.4 Archive `coord-who-poll-guidance` and `blocking-claim` when complete; re-run `openspec validate --all --strict` after archiving.
