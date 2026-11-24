## MODIFIED Requirements

### Requirement: Atomic file claims

Before a supported file edit, the plugin SHALL attempt to reserve all affected paths as one operation. A confirmed conflict SHALL prevent the entire edit and identify the owner and conflicting path. Reads SHALL NOT require a reservation. Sessions SHALL also be able to request claims explicitly before dispatching work.

A file resource SHALL include the working tree that holds the file. Sessions in two linked worktrees of one repository SHALL NOT conflict on files with the same relative path. Build and exclusivity resources SHALL stay project-wide.

An explicit claim SHALL name files. A claim on a directory SHALL be refused with a reason and reserve nothing.

#### Scenario: Concurrent edits

- **WHEN** two sessions request the same free path concurrently while Redis is available
- **THEN** only one receives the claim

#### Scenario: Multi-file patch with a rename

- **WHEN** one destination in a patch is held by another session
- **THEN** the patch changes no files and acquires no additional claims

#### Scenario: Same file name in two linked worktrees

- **WHEN** a session in one worktree edits a file that another session holds in a different worktree of the same repository
- **THEN** the edit is admitted

#### Scenario: Directory passed to an explicit claim

- **WHEN** a session claims a path that resolves to a directory
- **THEN** the claim is refused with a message that names the directory

### Requirement: Incumbent veto

An active session SHALL be able to request exclusive work or a stable-source foreground build. While a request is pending or granted, another session's parallel preference SHALL NOT authorize a new coordinated mutation. Reads SHALL remain available. Discovery SHALL include the owner, project scope, reason, phase and remaining lease time. `stable-build` mode SHALL keep blocking the owner's own source edits.

A session whose veto has left Redis through expiry or restart SHALL be treated as holding none. Its next edit, shell command or exclusivity request SHALL proceed from ordinary admission.

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

#### Scenario: Lease lost while exclusive

- **WHEN** an exclusive owner's record expires and the owner then edits a file
- **THEN** the edit is evaluated as an ordinary edit of a rejoined session

### Requirement: Waiting for held resources

`coord_wait` SHALL block until admission and, for a session that is already working in parallel, until no other session holds the requested paths. It SHALL take no path itself. Cancelling it SHALL NOT end the membership of a session that was already working.

An exclusivity request SHALL first obtain ordinary admission. A tool call that has finished while its provisional claim was not acknowledged SHALL be settled before any later operation is evaluated, so it cannot hold the project in the pending phase.

#### Scenario: Parallel session waits for a held file

- **WHEN** a parallel session calls `coord_wait` for a path held by another session
- **THEN** the call stays pending without taking the path, and returns once the path is released

#### Scenario: Exclusivity requested without a record

- **WHEN** a session with no record in Redis requests exclusivity in a project with no other participant
- **THEN** the request is admitted and granted

### Requirement: Uncoordinated shell writes

When a foreground shell command that appears to create, replace or remove project files completes, the plugin SHALL append a once-per-session notice to the tool result stating that shell writes are not coordinated and how to claim paths first. The notice SHALL NOT block the command or claim any path. A command that ends with an error SHALL NOT consume the notice.

#### Scenario: Redirect to a file

- **WHEN** a session runs a command with an output redirect to a file and the command completes
- **THEN** the command output carries the coordination notice, and later similar commands in that session do not repeat it

#### Scenario: Read-only command

- **WHEN** a session runs a command without file-writing operators, or one that only discards output
- **THEN** the tool result carries no notice

## ADDED Requirements

### Requirement: Understandable refusals

A conflict or read-only refusal SHALL name the owning session by its title and by the last six characters of its session ID, and SHALL show the path relative to the caller's working tree with a marker when it belongs to another worktree. A discovery call that cannot read the project SHALL report that failure instead of an empty list.

#### Scenario: Two sessions share a title

- **WHEN** two sessions have the same title and one holds a file the other requests
- **THEN** the refusal distinguishes the owner by the short ID
