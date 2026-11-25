## MODIFIED Requirements

### Requirement: Incumbent veto

An active session SHALL be able to request exclusive work or a stable-source foreground build. While a request is pending or granted, another session's parallel preference SHALL NOT authorize a new coordinated mutation. Reads SHALL remain available. Discovery SHALL include the owner, project scope, reason, phase and remaining lease time. Once `work` mode is granted, the owner MAY edit files that other sessions still list, because those sessions are read-only for its duration. `stable-build` mode SHALL keep blocking the owner's own source edits.

#### Scenario: Existing peer has an edit in flight

- **WHEN** an incumbent requests exclusivity while a peer is editing
- **THEN** the peer may finish that operation, but no new conflicting operation starts
- **AND** idle file reservations alone do not prevent the grant

#### Scenario: Exclusive owner edits a previously claimed file

- **WHEN** a session holds exclusive `work` mode and edits a file another session claimed earlier
- **THEN** the edit is admitted
- **AND** after the owner shares again, ordinary claim conflicts apply to both sessions

#### Scenario: Parallel override attempted

- **WHEN** an incoming session chooses parallel while another session has a veto
- **THEN** it can read or wait but cannot acquire write access or release the owner's veto

#### Scenario: Stable build

- **WHEN** the pending request drains
- **THEN** the plugin atomically grants stable sources and the build slot, and releases both after the foreground build

#### Scenario: Unavailable coordination

- **WHEN** Redis cannot verify the request
- **THEN** the plugin warns that exclusivity is not guaranteed and preserves the outage policy

### Requirement: Joining an active project

On the first work turn of an interactive top-level session, the plugin SHALL detect active peers in its project. When sharing is allowed, it SHALL offer Wait or Work in parallel by default. A pending or granted incumbent veto SHALL instead permit reading or waiting only. Idle session history SHALL NOT trigger the choice. Delegated and unattended sessions SHALL respect the same veto without an additional human prompt. `coord_wait` SHALL block until admission and, for a session that is already working in parallel, until no other session holds the requested paths. Cancelling it SHALL NOT end the membership of a session that was already working.

#### Scenario: Wait without blocking the other session

- **WHEN** a newcomer chooses Wait
- **THEN** it holds no claims, can cancel, and rechecks admission before proceeding

#### Scenario: Parallel session waits for a held file

- **WHEN** a parallel session calls `coord_wait` for a path held by another session
- **THEN** the call stays pending without taking the path, and returns once the path is released

#### Scenario: Simultaneous arrival

- **WHEN** two top-level sessions join an empty project concurrently with healthy Redis and default admission settings
- **THEN** at most one begins without seeing another participant

#### Scenario: Parallel work

- **WHEN** the user chooses Work in parallel and no veto is in effect
- **THEN** disjoint edits may proceed and ordinary file and build reservations still apply

## ADDED Requirements

### Requirement: Uncoordinated shell writes

When a foreground shell command that appears to write project files completes, the plugin SHALL append a once-per-session notice to the tool result stating that shell writes are not coordinated and how to claim paths first. The notice SHALL NOT block the command or claim any path.

#### Scenario: Redirect to a file

- **WHEN** a session runs a command with an output redirect to a file
- **THEN** the command output carries the coordination notice, and later similar commands in that session do not repeat it

#### Scenario: Read-only command

- **WHEN** a session runs a command without file-writing operators, or one that only discards output
- **THEN** the tool result carries no notice
