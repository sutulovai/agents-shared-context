## MODIFIED Requirements

### Requirement: Waiting for held resources

`coord_wait` SHALL block until admission and, for a session that is already working in parallel, until no other session holds the requested paths. It SHALL take no path itself. Cancelling it SHALL NOT end the membership of a session that was already working.

#### Scenario: Parallel session waits for a held file

- **WHEN** a parallel session calls `coord_wait` for a path held by another session
- **THEN** the call stays pending without taking the path, and returns once the path is released

#### Scenario: File availability is not a reservation

- **WHEN** a file wait completes
- **THEN** the result says the files are not reserved and advises re-reading and claiming them before editing

## ADDED Requirements

### Requirement: Explicit project wait

`/coord-wait` SHALL wait for other active participants and any other participant's veto, even when no files are held. A newcomer SHALL remain waiting until admission. Existing claims SHALL survive cancellation.

#### Scenario: Active peer without files

- **WHEN** a session requests project wait while another active participant holds no files
- **THEN** the wait remains pending until the peer leaves

#### Scenario: Multiple waiting newcomers

- **WHEN** multiple newcomers wait for a project
- **THEN** waiting participants do not themselves block each other

#### Scenario: Established waiters retain claims

- **WHEN** established participants with file claims wait for each other
- **THEN** at least one can proceed without revoking either participant's claims
- **AND** in-flight operations and vetoes still block project waits

#### Scenario: Wait superseded by parallel work

- **WHEN** a waiting session switches to parallel work and the earlier wait is cancelled
- **THEN** cancellation does not release the session's resumed claims or in-flight calls

### Requirement: Wait progress

A blocked wait SHALL submit cancellation guidance through tool progress and update it when its blocker changes. Client presentation is host-dependent. Peer-authored text SHALL NOT be treated as instructions.

#### Scenario: Blocker changes

- **WHEN** a wait observes a different blocker
- **THEN** it publishes an updated generic progress message
