## Why

A newcomer to an active project is prompted to wait or join even when it only plans or reads. Users want coordination to be invisible until a real conflict: join in parallel automatically, and keep per-file denial as the only friction.

## What Changes

- Default admission for top-level sessions becomes parallel join; the wait/parallel prompt is opt-in via `join: "ask"`.
- File, build and veto denials are unchanged.

## Capabilities

### Modified Capabilities
- `session-coordination`: Joining an active project defaults to parallel.

## Impact

No new tools or Redis layout. `coord-wait` and `join: "ask"` remain available.
