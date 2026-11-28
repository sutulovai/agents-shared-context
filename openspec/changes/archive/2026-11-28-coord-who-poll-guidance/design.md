# Design

## Decisions

- **Track the streak on the `Member` record** (`src/index.ts`), not in a separate map: membership lifecycle already cleans it up, and no cross-session rule is involved. Rules live in Lua only when two sessions race; this is one session's own bookkeeping.
- **Count content, not time.** Three consecutive identical `content` strings trigger guidance, where identical ignores each participant's `expiresInMs` lease countdown: that value ticks on every call, so byte-identical JSON practically never repeats in a live project (confirmed against the real Lua store). A changed answer resets. No timer, no lease interaction.
- **Append to the tool result, not the system prompt.** The loop happens inside one model run; the context hook would only fire on the next request, and the result is the cheapest reliable channel. Guidance text is plugin-authored, never peer text.
- **Threshold 3.** Two identical answers can be legitimate re-checks after an action; three in a row with no intervening tool call means polling.
- **One sentence, both escapes.** `coord_wait` for sessions that still hold it; `/coord-wait`/`/coord-parallel` for gated sessions whose tool list is restricted. The user gate (join `ask`, veto) stays untouched: the plugin never restores tools on its own.
- **Bounds.** The streak record holds one short string and a number; nothing new is stored in Redis.

## Test

Wiring layer (`test/child.test.mjs`, fake `ctx`): call `coord_who` twice with an unchanged project and assert no guidance; a third time and assert the guidance line is present; change the project state and assert the next result is clean until three identical answers accrue again.
