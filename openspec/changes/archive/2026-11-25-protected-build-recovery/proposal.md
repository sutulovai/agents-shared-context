# Proposal

## Why

A stale or unverifiable stable-build grant can be mistaken for protection. A lost stage response can also leave a finished operation blocking exclusivity.

## What Changes

- Refuse a recognized protected build when its grant is lost or cannot be verified, while preserving fail-open ordinary work.
- Revalidate duplicate vetoes by ownership and request identity, including requests still being established.
- Settle ambiguous stages by call identity and qualify the limits of exclusivity.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `session-coordination`: protected build recovery, veto revalidation and ambiguous stage settlement.

## Impact

The plugin hooks and Redis script change. Existing tool inputs and Redis lifetime remain unchanged.
