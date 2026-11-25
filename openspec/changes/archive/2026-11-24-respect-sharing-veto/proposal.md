## Why

A session's decision to join in parallel must not override another session's need for exclusive work or stable build inputs.

## What Changes

- Let an active owner request or release a temporary project-wide veto.
- Drain operations already in progress before granting exclusivity. Keep reads available.

## Capabilities

### Modified Capabilities
- `session-coordination`: Bilateral sharing policy and stable-source builds.

## Impact

Adds two native tools. Redis remains fail-open on outages.
