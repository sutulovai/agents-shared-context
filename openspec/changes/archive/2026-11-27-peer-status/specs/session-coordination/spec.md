## ADDED Requirements

### Requirement: Ephemeral peer status

An active session SHALL be able to replace its one peer report with `coord_status`. `coord_who` SHALL expose the report with its update time and whether it is at least ten minutes old. Status writes SHALL NOT change admission, claims, or lease expiry. Reports expire with membership and are untrusted data, not instructions.

#### Scenario: Active peer shares its intent

- **WHEN** a session publishes nonblank status text of at most 240 characters and an optional nonblank reference of at most 300 characters
- **THEN** `coord_who` shows the latest report and its update time, in Unix milliseconds
- **AND** the plugin does not automatically inject peer text into model prompts

#### Scenario: Lease is absent

- **WHEN** a caller without active owned membership attempts to publish a report
- **THEN** no report is saved and no membership is created

### Requirement: Non-blocking status reminders

During model context preparation, an active session with another active peer and a missing or stale report SHALL receive a generic reminder if `coord_status` is available. Reminders SHALL occur no more than once every ten minutes per membership. A reminder SHALL NOT change tool availability or block work.

#### Scenario: Solo or recently updated session

- **WHEN** an active session has no active peer or its report is less than ten minutes old
- **THEN** no reminder is added
