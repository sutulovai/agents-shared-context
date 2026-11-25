## MODIFIED Requirements

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

## ADDED Requirements

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
