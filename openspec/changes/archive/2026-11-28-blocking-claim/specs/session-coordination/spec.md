# Spec Delta

## ADDED Requirements

### Requirement: Blocking explicit claims

An explicit `coord_claim` MAY carry `wait: true`. When a requested path is then held by another session, the tool result SHALL stay pending instead of returning a conflict: it SHALL retry the same atomic claim at a regular interval until an attempt succeeds. Without `wait`, or when no requested path is held, `coord_claim` SHALL behave exactly as before. A waiting claim SHALL be subject to the same bounds, policies and conflict rules as an immediate claim.

#### Scenario: Parallel session blocks on a held file

- **WHEN** a parallel session calls `coord_claim` with `wait: true` for a path held by another session
- **THEN** the call stays pending, takes nothing, and progress names the holding session

#### Scenario: Winner is decided atomically

- **WHEN** two waiting sessions race for the same path after its holder releases it
- **THEN** exactly one attempt reserves it in a single Redis operation and the other keeps waiting without an error reaching the model

#### Scenario: Holder releases

- **WHEN** the holder releases or its lease expires while a `wait: true` claim is pending
- **THEN** a later retry reserves the paths, progress named the holder while it waited, and the result states the reservation as the caller's claim to release

#### Scenario: Cancellation reserves nothing

- **WHEN** the caller cancels a pending `wait: true` claim
- **THEN** the result reports the cancellation, names the last holder, and no path is reserved

#### Scenario: Immediate mode unchanged

- **WHEN** a session calls `coord_claim` without `wait` for a held path
- **THEN** the result is the same conflict denial as before

#### Scenario: Waiting claim respects policy

- **WHEN** a `wait: true` claim is pending and an incumbent veto makes the project read-only
- **THEN** the wait reports the veto in its progress instead of reserving

## MODIFIED Requirements

### Requirement: Waiting for held resources

`coord_wait` SHALL block until admission and, for a session that is already working in parallel, until no other session holds the requested paths. It SHALL take no path itself. Cancelling it SHALL NOT end the membership of a session that was already working. A session that wants the held paths for itself should use an explicit `coord_claim` with `wait: true`, which retries the atomic claim and reserves a freed path without a wake-then-claim race.

#### Scenario: Parallel session waits for a held file

- **WHEN** a parallel session calls `coord_wait` for a path held by another session
- **THEN** the call stays pending without taking the path, and returns once the path is released

#### Scenario: File availability is not a reservation

- **WHEN** a file wait completes
- **THEN** the result says the files are not reserved and advises re-reading and claiming them before editing

### Requirement: Repeated report guidance

When `coord_who` has returned the same answer for three consecutive calls within one membership, each later such result SHALL append one sentence stating that the project state is not changing by itself and that the session should call `coord_claim` with `wait: true` to reserve held paths as soon as they free up, call `coord_wait` to wait for the whole project, or ask the user to enter `/coord-wait` or `/coord-parallel` when the tools are restricted. The guidance SHALL NOT change admission, claims, leases, or tool availability.

#### Scenario: Identical reports in a row

- **WHEN** a session receives the same `coord_who` answer three times in a row
- **THEN** the third and every later identical answer carries the waiting guidance

#### Scenario: Ticking lease countdown

- **WHEN** consecutive answers show the same participants and reports and differ only in the participants' remaining lease time
- **THEN** they count as identical for the guidance

#### Scenario: State change resets the counter

- **WHEN** an answer differs from the previous one
- **THEN** the next identical answer alone carries no guidance until the count reaches three again
