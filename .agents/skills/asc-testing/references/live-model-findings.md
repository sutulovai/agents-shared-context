# Live-model findings

What real models did with the plugin's tools, in chronological order of discovery. Each entry is evidence for a design decision or a test. The scenarios live in `test/live.mjs`.

## How a live run is judged

The plugin is judged by what it refused, allowed and reported. The model is judged only on whether it used the tools. A run can fail because the model skipped a step while the plugin behaved correctly; say which was which.

Evidence to print on failure: the ordered transcript (texts and tool calls interleaved by timestamp), and with `ASC_TRACE=1` the tools each model request received.

## Session admission (`gate`)

Setup: the owner appends lines to `shared.txt` one edit per step; the peer starts later and is asked to append a line and create another file.

- With the scripted model the peer never received an edit tool. With `glm-5.3-flash` the peer received only `coord_who`, wrote nothing, and said: "To proceed, enter `/coord-wait` or `/coord-parallel`. I cannot release the owner's claim from this session." With `glm-5.4`: "Please enter `/coord-wait` or `/coord-parallel` to continue."
- In an unattended run with "do not ask questions" the same small model looked for any way to finish. The first such run looked like a bypass; the trace showed the owner had already finished and the project was free.

Assertion kept: no edit call by the peer, both commands named in its output, no file written.

## File conflict (`conflict`)

Setup: the owner loops on `shared.txt`; a parallel session is asked to append to it, then create `other.txt`.

- `glm-5.4`: three refusals `Conflict: file:shared.txt is held by ASC live test: owner loop.`, one `coord_wait` that stayed pending until the owner finished, then both writes in order. Owner lines intact; the peer's line last.
- The small model after a successful wait reported "appended" without calling the edit tool. Plugin behaved correctly.
- A frustrated peer requested exclusivity to "break the loop", which is allowed, then was still denied by the owner's claim. That was a plugin defect: exclusive mode now overrides earlier claims.

Assertions kept: the peer's successful write to the held file has a later timestamp than the owner's last write; `other.txt` exists; the last line is the peer's; the owner's line count is intact.

## Stable build (`stable-build`)

Setup: the owner loops on `loop.txt`; the main session is told that a final verification will run and that no other session should change sources meanwhile. The build script logs one line and sleeps eight seconds.

- `glm-5.4` called `coord_exclusive` with mode `stable-build` without being told the tool name, then ran the build once. The owner's next edit was refused with `Read-only: … requested exclusive access`. After the build the owner resumed.

Assertions kept: the build ran exactly once; an exclusive state with the build slot was observed in Redis or `coord_exclusive` was called.

## Model notes

- `zai-coding-plan/glm-5.3-flash` is fine for single-step reactions and for the scripted suite. It can skip a required tool call and describe the result as done, and it loops on reads when blocked.
- `zai-coding-plan/glm-5.4` followed multi-step instructions in every live scenario.
- A blocked model reads the refusal text closely. Naming the owning session by title and stating the allowed next step in the system text changed its next action.

## Second pass after the review fixes (`glm-5.3-flash`)

- `gate`: the peer checked `coord_who`, saw the owner's claim, and answered with both commands: "enter `/coord-wait` to take the claim safely, or `/coord-parallel` to proceed without coordination". No write.
- `conflict`: the peer read the file, called `coord_who`, waited with `coord_wait` until "Available: no other session holds shared.txt", claimed both files, and then wrote `shared.txt` with `write` instead of `edit`. Plugin behaviour correct; the test had to accept both tools.
- `stable-build`: `coord_exclusive` was found and used without being named; the owner's edit was refused with `Read-only`. The model then ran the build three times because the stub printed nothing, and called `coord_share` when told that protection had ended. The reruns ran as ordinary builds, which the specification allows. The tool result of a finished stable build now says that protection ended and how to ask again.

Assertion kept for the build: it ran at least once and the neighbour was refused at least once while the session held exclusivity. The number of runs is recorded, not asserted.

## Blocking claim (`gpustack/glm-5.3-flash`, 2026-11-28)

- `blocking-claim`: the peer called `coord_claim` with `wait: true` on the first try, made zero `coord_who` polls, and wrote `shared.txt` with `edit` once the reservation landed. The owner's 40 edits ran without a refusal; the peer's write came after the owner's last one.
- Scenario design: a live owner that must hold a file for its whole turn needs an explicit `coord_claim` first. The claim an edit takes is provisional and ends with the tool call, so a peer's blocking claim succeeded between the owner's edit steps in the first design and the owner then met a `Conflict`.
- Assertion design: `toolCalls()` drops the event `timestamp`; ordering assertions must compare on the raw `tool_use` events. Two runs failed on these two mistakes before the scenario passed on the third.
