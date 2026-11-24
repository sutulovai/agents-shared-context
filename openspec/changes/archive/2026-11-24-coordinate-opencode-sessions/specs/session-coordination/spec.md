## ADDED Requirements

### Requirement: Project-scoped activity
The plugin SHALL report active participating sessions, their short task labels, and their claimed files within the calling session's project. Activity records SHALL expire. The plugin SHALL NOT store prompts, file contents, credentials, or owner tokens in user-visible reports.

#### Scenario: Same directory name in different projects
- **WHEN** two unrelated repositories have the same directory name
- **THEN** their sessions and claims remain separate

### Requirement: Atomic file claims
Before a supported file edit, the plugin SHALL attempt to reserve all affected project paths as one operation. A confirmed conflict SHALL prevent the entire edit and identify the owner and conflicting path. Reads SHALL NOT require a reservation. Sessions SHALL also be able to request claims explicitly before dispatching work.

#### Scenario: Concurrent edits
- **WHEN** two sessions request the same free path concurrently while Redis is available
- **THEN** only one receives the claim

#### Scenario: Multi-file patch with a rename
- **WHEN** one destination in a patch is held by another session
- **THEN** the patch changes no files and acquires no additional claims

### Requirement: Expiring ownership
Healthy sessions SHALL have no maximum duration. By default, claims SHALL expire ten minutes after the last successful renewal. While their owning operation is active, the plugin SHALL attempt renewal every minute, including during long model and tool calls. Renewal and release SHALL verify the current ownership token. An idle session with no outstanding operation SHALL stop renewing and release its claims.

#### Scenario: Stale owner resumes
- **WHEN** an expired owner's delayed refresh or release arrives after a new owner acquires the file
- **THEN** the new owner's lease remains unchanged

#### Scenario: Build outlasts the lease interval
- **WHEN** a foreground build continues for an hour and renewals succeed
- **THEN** other participants see the build reservation for the entire operation

### Requirement: Joining an active project
At the first work turn of a new interactive top-level session, the plugin SHALL detect other active participants in its project. If any are present, it SHALL show their tasks and offer Wait or Work in parallel before starting work. Idle session history SHALL NOT trigger the choice. Delegated sessions SHALL NOT prompt the human again.

#### Scenario: Wait without blocking the other session
- **WHEN** the user chooses Wait
- **THEN** the waiting session holds no claims, can cancel, and rechecks active work before proceeding

#### Scenario: Simultaneous arrival
- **WHEN** two top-level sessions join an empty project concurrently with healthy Redis
- **THEN** at most one begins without seeing another participant

#### Scenario: Parallel work
- **WHEN** the user chooses Work in parallel
- **THEN** disjoint edits may proceed and ordinary file and build reservations still apply

### Requirement: Shared build resources
For supported direct foreground build commands, the plugin SHALL reserve a project-wide build resource before launch. The reservation SHALL conflict with other supported builds in the project, not with edits to different source files. Unknown shell commands and processes that outlive the tool call SHALL NOT be described as protected builds.

#### Scenario: Different source files but common build outputs
- **WHEN** two sessions edit different files and request builds sharing an output directory
- **THEN** both edits are permitted, but only one coordinated build starts until the first exits or its lease expires

### Requirement: Local startup and degraded operation
In managed mode the plugin SHALL start its own loopback-only Redis container on demand. Concurrent starts SHALL converge on one instance. If coordination is unavailable, it SHALL warn the affected session and allow its edit. It SHALL NOT report a successful reservation or an empty list of active sessions merely because Redis failed to answer.

#### Scenario: Docker is stopped
- **WHEN** a session attempts a supported edit and managed Redis cannot start within the startup deadline
- **THEN** the session receives an actionable warning and the edit proceeds subject to existing OpenCode permissions

#### Scenario: Redis recovers
- **WHEN** a session attempts another edit after an outage
- **THEN** the plugin checks ownership again before treating the edit as coordinated
