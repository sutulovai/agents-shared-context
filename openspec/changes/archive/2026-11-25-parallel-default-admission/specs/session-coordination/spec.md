## MODIFIED Requirements

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
