# Spec Delta

## ADDED Requirements

### Requirement: Repeated report guidance

When `coord_who` has returned the same answer for three consecutive calls within one membership, each later such result SHALL append one sentence stating that the project state is not changing by itself and that the session should call `coord_wait` to block until it does, or ask the user to enter `/coord-wait` or `/coord-parallel` when the tools are restricted. The guidance SHALL NOT change admission, claims, leases, or tool availability.

#### Scenario: Identical reports in a row

- **WHEN** a session receives the same `coord_who` answer three times in a row
- **THEN** the third and every later identical answer carries the waiting guidance

#### Scenario: Ticking lease countdown

- **WHEN** consecutive answers show the same participants and reports and differ only in the participants' remaining lease time
- **THEN** they count as identical for the guidance

#### Scenario: State change resets the counter

- **WHEN** an answer differs from the previous one
- **THEN** the next identical answer alone carries no guidance until the count reaches three again
