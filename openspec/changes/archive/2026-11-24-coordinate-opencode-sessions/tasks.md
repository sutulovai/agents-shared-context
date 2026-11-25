## 1. Prove the OpenCode hook boundary

- [x] 1.1 Drive two real OpenCode 2.3.2 servers with an isolated local model fixture. `ASC_TRACE=1` records permission resources and lifecycle diagnostics without prompts.
- [x] 1.2 Exercise a multi-file rename, nested working directory, mixed paths, rejected permission, and native deny during an outage.
- [x] 1.3 Exercise wait, parallel and cancellation via native commands. Test simultaneous arrival against Redis and child admission at the plugin boundary. No TUI extension required.

## 2. Implement and test leases against real Redis

- [x] 2.1 Cover concurrent requests, disjoint paths, all-or-nothing expansion and separate project identities.
- [x] 2.2 Verify token-checked renewal and release against real Redis, including expired owners and overlapping provisional tool calls.

## 3. Wire the plugin and managed service

- [x] 3.1 Expose `coord_who` and `coord_claim`; cover long foreground operations, cancellation, stale idle events and cleanup.
- [x] 3.2 Test concurrent managed startup, stopped-container recovery, local socket selection, container ownership and an occupied port.
- [x] 3.3 Verify offline discovery, visible warnings, continued edits, and conflict detection after restoring the Redis connection.
- [x] 3.4 Serialize recognized foreground builds conservatively per project. Verify that only one build process starts, renewal outlasts the initial TTL, and a failed process frees its reservation.

## 4. Verify the public package

- [x] 4.1 Wire CI to run formatting, TypeScript, Redis, Docker and packaged acceptance checks. Exercise these gates locally; hosted CI runs on push or pull request.
- [x] 4.2 Document installation, removal, supported writes and privacy limits. Assert the packed package's file allowlist before testing it as a consumer.
