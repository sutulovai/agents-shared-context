# Session coordination

## Purpose

Let independent OpenCode sessions discover active work and reserve shared files or build resources, while keeping editing available during local Redis outages.

## Requirements

### Requirement: Project-scoped activity

The plugin SHALL report active participating sessions, their short task labels, and their claimed files within the calling session's project. Activity records SHALL expire. The plugin SHALL NOT store prompts, file contents, credentials, or owner tokens in user-visible reports.

#### Scenario: Same directory name in different projects

- **WHEN** two unrelated repositories have the same directory name
- **THEN** their sessions and claims remain separate

### Requirement: Atomic file claims

Before a supported file edit, the plugin SHALL attempt to reserve all affected paths as one operation. A confirmed conflict SHALL prevent the entire edit and identify the owner and conflicting path. Reads SHALL NOT require a reservation. Sessions SHALL also be able to request claims explicitly before dispatching work.

#### Scenario: Concurrent edits

- **WHEN** two sessions request the same free path concurrently while Redis is available
- **THEN** only one receives the claim

#### Scenario: Multi-file patch with a rename

- **WHEN** one destination in a patch is held by another session
- **THEN** the patch changes no files and acquires no additional claims

### Requirement: Working-tree scope of file claims

A file resource SHALL include the working tree that holds the file. Sessions in two linked worktrees of one repository SHALL NOT conflict on files with the same relative path. Build and exclusivity resources SHALL stay project-wide.

#### Scenario: Same file name in two linked worktrees

- **WHEN** a session in one worktree edits a file that another session holds in a different worktree of the same repository
- **THEN** the edit is admitted

### Requirement: Directory claims are refused

An explicit claim SHALL name files. A claim on a directory SHALL be refused with a reason and reserve nothing.

#### Scenario: Directory passed to an explicit claim

- **WHEN** a session claims a path that resolves to a directory
- **THEN** the claim is refused with a message that names the directory

### Requirement: Expiring ownership

Healthy sessions SHALL have no maximum duration. By default, claims SHALL expire ten minutes after the last successful renewal. While their owning operation is active, the plugin SHALL attempt renewal every minute, including during long model and tool calls. Renewal and release SHALL verify the current ownership token. An idle session with no outstanding operation SHALL stop renewing and release its claims.

#### Scenario: Stale owner resumes

- **WHEN** an expired owner's delayed refresh or release arrives after a new owner acquires the file
- **THEN** the new owner's lease remains unchanged

#### Scenario: Build outlasts the lease interval

- **WHEN** a foreground build continues for an hour and renewals succeed
- **THEN** other participants see the build reservation for the entire operation

### Requirement: Joining an active project
On the first coordinated operation of a top-level session, the plugin SHALL join the project in parallel by default. It SHALL prompt for Wait or Work in parallel only when the configuration sets `join` to `ask`. A pending or granted incumbent veto SHALL instead permit reading or waiting only. Idle session history SHALL NOT trigger admission. Delegated and unattended sessions SHALL respect the same veto without an additional human prompt.

#### Scenario: Disjoint newcomer edits
- **WHEN** a top-level session starts a coordinated operation while another session holds unrelated files and default admission is in effect
- **THEN** the newcomer joins in parallel without a prompt and its operation proceeds

#### Scenario: Overlapping newcomer edit
- **WHEN** the newcomer's coordinated operation includes a file held by another session
- **THEN** the whole operation is denied with the resource and owning session, exactly as for a session that joined earlier

#### Scenario: Ask mode restored
- **WHEN** the configuration sets `join` to `ask`
- **THEN** the newcomer of an active project is offered Wait or Work in parallel before its first coordinated operation

#### Scenario: Wait without blocking the other session
- **WHEN** a newcomer chooses Wait
- **THEN** it holds no claims, can cancel, and rechecks admission before proceeding

#### Scenario: Simultaneous arrival
- **WHEN** two top-level sessions join an empty project concurrently with healthy Redis and default admission settings
- **THEN** at most one begins without seeing another participant

#### Scenario: Parallel work
- **WHEN** the user chooses Work in parallel and no veto is in effect
- **THEN** disjoint edits may proceed and ordinary file and build reservations still apply

### Requirement: Waiting for held resources

`coord_wait` SHALL block until admission and, for a session that is already working in parallel, until no other session holds the requested paths. It SHALL take no path itself. Cancelling it SHALL NOT end the membership of a session that was already working.

#### Scenario: Parallel session waits for a held file

- **WHEN** a parallel session calls `coord_wait` for a path held by another session
- **THEN** the call stays pending without taking the path, and returns once the path is released

#### Scenario: File availability is not a reservation

- **WHEN** a file wait completes
- **THEN** the result says the files are not reserved and advises re-reading and claiming them before editing

### Requirement: Settled calls before new operations

An exclusivity request SHALL first obtain ordinary admission. A tool call that has finished while its provisional claim was not acknowledged SHALL be settled before any later operation is evaluated, so it cannot hold the project in the pending phase.

#### Scenario: Exclusivity requested without a record

- **WHEN** a session with no record in Redis requests exclusivity in a project with no other participant
- **THEN** the request is admitted and granted

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

### Requirement: Incumbent veto

An active session SHALL be able to request exclusive work or a stable-source foreground build. While a request is pending or granted, another session's parallel preference SHALL NOT authorize a new coordinated mutation. Reads SHALL remain available. Discovery SHALL include the owner, project scope, reason, phase and remaining lease time. `stable-build` mode SHALL keep blocking the owner's own source edits.

#### Scenario: Existing peer has an edit in flight

- **WHEN** an incumbent requests exclusivity while a peer is editing
- **THEN** the peer may finish that operation, but no new conflicting operation starts
- **AND** idle file reservations alone do not prevent the grant

#### Scenario: Parallel override attempted

- **WHEN** an incoming session chooses parallel while another session has a veto
- **THEN** it can read or wait but cannot acquire write access or release the owner's veto

#### Scenario: Stable build

- **WHEN** the pending request drains
- **THEN** the plugin atomically grants stable sources and the build slot, and releases both after the foreground build

#### Scenario: Unavailable coordination

- **WHEN** Redis cannot verify the request
- **THEN** the plugin warns that exclusivity is not guaranteed and preserves the outage policy

### Requirement: Veto lost with the lease

A session whose veto has left Redis through expiry or restart SHALL be treated as holding none. Ordinary work SHALL proceed from ordinary admission. A recognized build explicitly awaiting stable-source protection SHALL NOT launch if its expected grant is lost or cannot be verified.

#### Scenario: Lease lost while exclusive

- **WHEN** an exclusive owner's record expires and the owner then edits a file
- **THEN** the edit is evaluated as an ordinary edit of a rejoined session

#### Scenario: Protected build loses its grant

- **WHEN** a recognized foreground build follows a stable-build grant that Redis no longer holds or cannot verify
- **THEN** the plugin refuses the build before shell launch instead of retrying it as an ordinary build

#### Scenario: An edit follows a lost stable-build grant

- **WHEN** an ordinary edit rejoins after a stable-build grant is lost
- **THEN** the next recognized build is still treated as protected until it is refused, completed, or explicitly cancelled

### Requirement: Exclusive precedence over earlier claims

Once `work` mode is granted, the owner MAY edit files that other sessions still list, because those sessions are read-only for its duration. When the owner shares again, earlier claims SHALL conflict as before.

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

### Requirement: Uncoordinated shell writes

When a foreground shell command that appears to create, replace or remove project files completes, the plugin SHALL append a once-per-session notice to the tool result stating that shell writes are not coordinated and how to claim paths first. The notice SHALL NOT block the command or claim any path. A command that ends with an error SHALL NOT consume the notice.

#### Scenario: Redirect to a file

- **WHEN** a session runs a command with an output redirect to a file and the command completes
- **THEN** the command output carries the coordination notice, and later similar commands in that session do not repeat it

#### Scenario: Read-only command

- **WHEN** a session runs a command without file-writing operators, or one that only discards output
- **THEN** the tool result carries no notice

### Requirement: Understandable refusals

A conflict or read-only refusal SHALL name the owning session by its title and by the last six characters of its session ID, and SHALL show the path relative to the caller's working tree with a marker when it belongs to another worktree. A discovery call that cannot read the project SHALL report that failure instead of an empty list.

#### Scenario: Two sessions share a title

- **WHEN** two sessions have the same title and one holds a file the other requests
- **THEN** the refusal distinguishes the owner by the short ID

### Requirement: Duplicate veto identity

A duplicate exclusivity request SHALL be refused while the local request is being established or Redis still holds that exact request for the same owner. A stale local request SHALL NOT block a new request.

#### Scenario: Concurrent request during admission

- **WHEN** a second exclusivity request arrives while the first is still establishing its Redis record
- **THEN** the second request is refused without replacing the first

#### Scenario: Lease lost before a new request

- **WHEN** an earlier veto has left Redis and the owner requests exclusivity again
- **THEN** the new request is evaluated instead of being refused as a duplicate

### Requirement: Ambiguous stage settlement

The plugin SHALL remember a stage attempt before sending it. A completed or refused call with an ambiguous stage reply SHALL be settled by its call identity without removing another call's reservations.

#### Scenario: Stage reply is lost

- **WHEN** Redis applies a stage but its reply is lost and the tool finishes
- **THEN** a later successful operation settles that call and it no longer blocks exclusivity

#### Scenario: Protected shell launch is refused

- **WHEN** a protected shell stage has an ambiguous reply and the before hook rejects the launch
- **THEN** the plugin schedules abandonment without relying on an after callback

### Requirement: Scope of exclusivity

An exclusivity grant SHALL describe its coverage as limited to tracked coordinated operations. It SHALL NOT claim to drain manual, external or no-longer-tracked operations.

#### Scenario: Grant after lease loss

- **WHEN** an operation is no longer tracked because its session lost its lease
- **THEN** a later grant does not assert that the operation has drained

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
