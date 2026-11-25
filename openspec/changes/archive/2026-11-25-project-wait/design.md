## Design

The command creates a one-shot project-wait request. New participants remain waiting until ordinary admission succeeds. Existing participants retain their claims. A Redis probe checks other active participants and vetoes atomically. Direct tool calls continue to probe file claims.

Tool progress contains generic text, while blocker identity is used only to deduplicate updates. Progress is not a guarantee that every client renders it.

Established project waiters retain their claims. A short-lived Redis marker makes a waiter ignorable by project waits only, and in-flight calls and vetoes still block. The marker is cleared when waiting ends or coordinated work resumes.

Each wait has an identity. Cleanup of a superseded wait does not clear a newer wait marker or end resumed membership.
