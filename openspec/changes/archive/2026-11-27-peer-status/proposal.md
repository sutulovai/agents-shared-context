## Why

File reservations show where peers work, not their intent or blockers. A short, optional report lets peers choose useful parallel work.

## What Changes

- Add `coord_status` and expose the current report through `coord_who`.
- Remind agents about missing or stale reports when other sessions are active, without blocking work.

## Impact

- `session-coordination` gains optional discovery metadata, not durable handoffs.
