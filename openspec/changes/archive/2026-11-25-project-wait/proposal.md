## Why

An explicit project wait must not finish while another participant remains active without file claims.

## What Changes

- Make `/coord-wait` wait for active peers and vetoes, regardless of default admission.
- Report wait progress without treating peer text as instructions.
- Explain that file availability is not a reservation.

## Capabilities

### Modified Capabilities

- `session-coordination`: project wait and progress.

## Impact

The coordination store, plugin tools and user documentation change. Direct file waits retain their existing inputs.
