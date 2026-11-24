## Why

An independent review found three ways for a session to be blocked or misled while Redis was healthy: a veto that Redis no longer held still blocked its own owner, two linked worktrees produced false conflicts on same-named files, and a claim on a directory reserved nothing an edit could match.

## What Changes

- File resources carry the working tree they belong to. Builds and exclusivity remain project-wide.
- An explicit claim on a directory is refused with a reason.
- A veto missing from Redis is dropped from the session's memory and the session rejoins on its next operation.
- A finished tool call whose result Redis never acknowledged is settled on the next successful operation.
- Conflict and read-only messages name the owning session's title and the last six characters of its ID.
- `coord_exclusive` admits the session first, `coord_who` reports a non-empty failure instead of an empty list, and the shell-write notice covers more commands and is not spent on a failed command.

## Capabilities

### Modified Capabilities

- `session-coordination`: Working-tree scope of file claims, explicit claim input, and messages.

## Impact

No configuration change. Resource keys stored in Redis change shape; both are transient and expire with their lease.
