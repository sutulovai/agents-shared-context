## Why

Live-model sessions exposed three gaps that scripted tools could not:

- `coord_wait` returned immediately for a session already working in parallel, even while another session held the file.
- A session that was granted project exclusivity was still denied edits by the other session's earlier file claims.
- A session bypassed coordination with a shell redirect and received no indication that the write was invisible to other sessions.

## What Changes

- `coord_wait` accepts optional `paths` and waits until no other session holds them, or holds any file when omitted.
- Exclusive `work` mode overrides earlier file claims of other sessions, which are read-only for its duration.
- Shell commands that look like file writes append a once-per-session coordination notice to the tool result.
- Conflict and read-only messages name the owning session by its title.

## Capabilities

### Modified Capabilities

- `session-coordination`: Waiting, exclusivity precedence, and uncoordinated shell writes.

## Impact

No configuration change. Redis state format is unchanged apart from a new read-only `probe` operation.
