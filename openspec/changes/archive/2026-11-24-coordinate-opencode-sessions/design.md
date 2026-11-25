## Approach

Use a TypeScript server plugin for OpenCode v2. The plugin owns registration, renewal, and cleanup. A CLI or a skill alone would depend on agents remembering to run commands, particularly during long tool calls. Redis and Lua provide one atomic decision across independent plugin instances.

## Identity and storage

Resolve the directory from the calling session. Hash the canonical Git common directory, falling back to the session directory outside Git. Normalize paths relative to the checkout root, resolve symlinked ancestors, and case-fold conservatively. For renames, claim both sides.

Use one Redis hash per project with a field per participating session. Redis 7.4 field expiration keeps membership and all its reservations on the same clock. A Lua invocation reads only that project's bounded set (128 sessions, 256 paths per owner), checks for conflicts, then writes. No global key scan or stale secondary index. A native edit is provisional until its tool succeeds; rejection drops only that invocation's claim. Explicit claims and overlapping successful calls remain held. A random ownership token guards renewal and release. A replacement plugin instance with the same session ID cannot evict an unexpired owner.

## Failure semantics

The lease timeout is a crash-recovery budget, not a session-duration limit. The default is ten minutes since last renewal, with a one-minute plugin heartbeat. The heartbeat checks that the host still reports an active session. A running foreground tool counts as activity even when it produces no output. After interruption or expiry, verify ownership before the next coordinated operation. Longer timeouts tolerate pauses but delay takeover after a crash.

## Joining and building

At first interactive work, atomically check membership and announce arrival. A waiting session is visible but is not an active writer; do not let waiters keep one another waiting. Recheck atomically when waking. Count active delegated work even if its parent is idle. The human decision applies to the joining session; parallel mode never overrides an existing resource reservation. If Redis is unavailable, apply the warning-only policy without asking the user to wait for an unknown peer.

Transitive build outputs depend on each project's build configuration. Instead of guessing their locations, take a single project-wide resource for recognized foreground builds. This can serialize independent worktrees unnecessarily, but does not block edits. A build reservation does not freeze sources or guarantee a reproducible snapshot while someone edits them.

## Degraded operation

Distinguish `acquired`, `conflict`, and `unavailable`. On conflict, deny only the affected edit. On unavailability, retain OpenCode's original permission decision and surface an uncoordinated-edit warning. Do not convert an existing `ask` or `deny` to `allow`. Deduplicate repeated outage notices per session without hiding degraded status. Retry against Redis on subsequent edits; never replay offline claims as if they had succeeded.

Bind managed Redis to loopback. Check container ownership, port binding, and readiness; do not adopt an unknown service or remove a conflicting container. Bound startup and connection waits. Redis contents are transient; no secret or machine-specific configuration belongs in Git.

## Verified hook boundary

On OpenCode 2.3.2, a native patch requests `edit` for every affected path, including both sides of a rename, before applying the patch. Resource paths are relative to the session directory even when started in a nested module. A mixed patch still checks its supported paths. Do not infer arbitrary shell write sets. After lease loss, no scheme here can undo an in-flight write.
