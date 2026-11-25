## Why

Independent OpenCode sessions can silently overwrite each other's edits in one checkout. Starting a worktree for every small change costs more than a short-lived reservation on the files involved.

## What Changes

- Introduce an OpenCode server plugin that reports active sessions and reserves paths before supported edits.
- Offer a joining user a choice to wait or work in parallel. Reserve shared build outputs separately from source files.
- Coordinate through one local Redis instance. Start the managed instance on demand. Let editing continue with a visible warning if coordination is unavailable.
- Keep only current activity and expiring claims. Do not store conversations or source code.

## Capabilities

### New Capabilities
- `session-coordination`: Project-scoped presence, atomic file reservations, and degraded operation.

### Modified Capabilities
None.

## Impact

Users enable one global plugin. Managed mode requires a local Docker engine. No shell customization, terminal integration, or changes to participating repositories are required.
