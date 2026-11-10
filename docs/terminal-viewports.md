# Terminal source grid and device viewports

A tmux pane has one cursor-addressed character grid. Replaying raw ANSI cursor
updates into a differently sized client corrupts its layout. Desktop keeps that
grid; mobile instead wraps complete captured frames into a native DOM document
and remaps their cursor.
Mobile preserves content and color, allowing different line/table layouts.

Every session shares one source width, so output is laid out the same in every
window whether or not anyone is looking at it. Output printed by an agent keeps
the width it was printed at, so a session left at its own width stays visibly
different after it is opened. Source rows stay at 40.

The shared width is calculated from the terminal area and font metrics of the
desktop window in use, between 80 and 240 columns; the sidebar and font controls
update it. New sessions start at it, and sessions no desktop is fitting move to
it a few at a time after the layout has been stable for 3 seconds. Recovery still
adopts existing dimensions; those sessions join once a desktop reports a width.
A resize makes the application redraw, so state detection pauses for 4 seconds
and the redraw counts as neither activity nor a state change. Sessions attached
from outside AgentBoard are not moved. With no desktop connected, nothing moves.

Each resize costs the reader something. Claude Code clears the screen and draws
the end of the conversation again from its top, so the rows above keep a cut-off
old copy. tmux re-wraps every row wider than the new width, so the tables above
break apart. A desktop pane that stays within 10% of the session's width
therefore keeps it: the grid scales down or leaves a margin. The shared width
follows the same rule. A new font size or browser zoom changes the cell size and
gets its exact width instead. Desktop viewport requests wait 400 ms, so a dragged
divider resizes once, where it stops.

When a narrower width does break a box-drawn table in history, the desktop joins
its rows back where tmux marked them soft-wrapped and draws the table again at
the current width, using the phone's projection with columns kept side by side.
Prose, pipe tables (usually source text there) and the source screen keep their
rows. The soft-wrap check accepts two things a reflow leaves behind: a wide glyph
moved off the last column with no padding cell, and an empty continuation row
that `-J` folds away. Either one used to drop the whole frame's wrap metadata.

Two more repairs apply to the desktop's history and to phones. The row above the
redraw keeps its wrap mark, so the first redrawn table row is joined to the old
copy (on one row once a wider reflow joins them); it is split off where a row
with the next row's indent and column widths starts. After widening, Claude Code
writes its first redrawn table rows broken where the old width ended, the second
piece indented and with no wrap mark. Such a pair is joined only when the result
has the column widths of a neighbouring row. One cut-off row per resize and the
duplicate copy remain; they are what the application wrote.

A split pane or grid tile is the one exception: a session visible there fits that
pane for as long as it is shown, while the shared width still comes from the full
terminal area. It rejoins 30 seconds after leaving, so flipping tabs does not
reflow it. A desktop with recent input (pointer, key or window focus in the last
5.5 seconds) claims both the sessions it shows and the shared width. A window left
open elsewhere keeps renewing its lease but never claims; while another window
owns a session it fits that source grid by scaling or spare width.

Viewport requests are debounced and renewed every five seconds. Ownership is
released when a terminal unmounts, its browser tab becomes hidden, or its socket
disconnects. A 15-second lease also releases abandoned clients.

Mobile viewers never resize the source. They retain their native font size and
calculate local columns from the available phone width. Captured rows wrap to
those columns using the same Unicode 11 cell widths as xterm; ANSI colors and
the cursor position are retained. Wrapping prefers whitespace between words and
Korean eojeol, and keeps combining marks and emoji sequences together. Only
tokens wider than the available row need character wrapping. Explicit newlines
and source indentation stay intact. Long text/code rows can span multiple mobile lines. Wide boxed and Markdown
tables are projected into narrower columns with wrapping inside each cell.
Tables with more than five columns, or too little room for usable cell widths,
use vertically stacked records. Short names/statuses get width before prose.
Fitting tables retain their original layout. Shell pipes and unverified box art
are not inferred as tables; a visible editing cursor inside a table keeps its
original character mapping. There is no horizontal scrolling or automatic font shrinking. A+/A−
change the actual mobile font size; mobile and desktop preferences are separate.

Each client caches unmodified source snapshots/screens. Rotation and mobile
font changes reflow this source again, never already-wrapped output. Live screen
updates replace the original source rows before reflow; if wrapping changes the
screen height, the client rebuilds with the original history so stale screen
rows do not become history. Trailing unused source padding is omitted on mobile,
but content and the cursor row are kept. Desktop retains the source grid layout,
except for history tables a narrower width broke (above).
Table projection uses the complete cached history plus the latest source screen,
so a table spanning that boundary keeps consistent column widths. Projection
never replaces the cached source. Phone text uses a single native scroll surface. Enter in the mobile input card
inserts a newline; Send submits. Desktop retains Enter-to-send and Shift+Enter
for a newline. The ambiguous mobile Enter quick key and range-copy button were
removed.

On touch devices the terminal output is a normal text document, not a relocated
xterm viewport. The browser owns vertical touch scrolling, momentum, direction
changes and text selection (long press and native Copy handles/menu). Swipes do
not send keys to the shared PTY; alternate-screen history remains reachable via
the explicit PgUp/PgDn controls. Desktop still uses xterm's renderer and input.
ANSI styling is applied using text nodes and allowlisted CSS properties; terminal
content is never interpreted as HTML. There is one scroll surface, no synthetic
inertia and no horizontal panning. Phone fonts stay at the configured size.

Each native row retains its DOM nodes while unchanged. Stable history is cached;
live updates reflow only a source tail, retaining whole table/box blocks and
verified wrap chains across the history/screen boundary. Snapshots and width
changes rebuild from raw captures. A text anchor preserves reading position when
a geometry snapshot shifts preceding rows. Normal live updates and snapshots
are deferred while reading history. No asynchronous terminal write callback can
move the native viewport after a swipe has begun.

Output and geometry updates pause from the initial press until native selection
ends. Only the newest snapshot and subsequent screen are retained with their grid
versions. Clearing selection resumes output; unmounting clears the old selection.
This pauses the local document only. Font/width changes wait until selection ends.
Long status dividers and recognized CLI footers lose only decorative width and
alignment padding; single-column input boxes retain their text and mapped cursor.
Original captures remain available to the desktop. Arbitrary code whitespace is
not collapsed and explicit paragraph/code newlines are not guessed away.

Recovery adopts the existing tmux pane dimensions, without resizing running
processes. If dimensions could not be read, frames pause until a viewport request
verifies them; a mobile request can verify dimensions without resizing.

Screen and snapshot events carry actual `cols` and `rows`, plus a `gridVersion`.
Resizing invalidates captures in progress. Clients discard older versions and
replace old-width scrollback with a fresh snapshot before applying new screen
frames. If tmux dimensions cannot be verified, frames pause until a subsequent
viewport request successfully verifies them. `dynamicWidth: true` advertises
support, allowing clients to retain the fixed-grid fallback for older servers.
Legacy resize requests cannot take over source dimensions.

With `fullRows: true`, frames preserve trailing blank screen rows, and desktop
xterm views may have additional rows above the source screen to display history.
Live screen updates overwrite only the source-screen region, preserving the
extra history rows above it. Resizing replays applied frames at the new height.
Older server frames retain the source height on desktop. Full-screen programs
with no server scrollback cannot supply extra history.
Desktop fits its source grid without horizontal overflow. Source snapshots and
cursors are captured together so cursor coordinates do not come from a previous
screen while output is streaming.

Frames optionally carry `wrappedRows`, indices of source rows with a verified
terminal soft wrap. The backend captures normal and `-J` text plus the cursor
in one tmux command queue, and validates every physical row before publishing
these indices. Mobile joins those boundaries before wrapping at its own width;
it never infers paragraphs from prose. A paragraph crossing history and screen
is rebuilt from cached source coordinates, including during live updates.
Wrap metadata changes trigger an update even if the visible characters match.
Inconsistent captures fall back to the unchanged physical rows.

There is a source limitation: tmux 3.0a's joined capture exports unused cells
before wide characters as spaces, indistinguishable from spaces actually written
by the application ([upstream implementation](https://github.com/tmux/tmux/blob/3.0a/grid.c#L843-L905)).
Historical explicit newlines emitted by a CLI do not carry enough metadata to
reconstruct its original paragraphs. A wider desktop cannot safely merge them
without the original message data. No heuristic paragraph joining is performed.
Those spaces are preserved; deleting them could change words or code. This is a
terminal-grid projection, not a lossless reconstruction of the application's
original text stream. Applications that print explicit line breaks keep them.

Session visibility/order and process state remain shared. Display scale,
scroll position, and viewport dimensions are client concerns. Application
history navigation (PageUp/PageDown) is still input to the shared process and
therefore affects its output on other devices.

## Separate mobile conversation view

The terminal toolbar now offers a separate **대화** view on both device layouts.
It reads original user/assistant messages from local Codex/Claude JSONL records,
so paragraphs and code wrap at the viewing device's width independently of tmux.
The terminal remains available for shells, tools, interactive prompts and agents
without supported records. This view does not reconstruct missing source data or
display hidden reasoning/tool payloads.

Automatic binding requires an open transcript file descriptor or an explicit
resume/session identifier in the nearest agent process. Transcript metadata must
match the workspace. A latest-file/mtime heuristic is never used. If ownership
cannot be established, users explicitly choose a conversation from that workspace.
Manual bindings include pane and agent process start identities, so replacing an
agent or reusing a terminal ID does not restore the previous conversation.

The authenticated API uses byte-offset pagination and stable record IDs. Old
requests are discarded after session/source changes. Reading/selection pauses
local updates. Source records larger than the bounded reading window may be
omitted with an explicit notice. Remote-host transcripts are not relayed yet.
Raw HTML is sanitized, automatic resource loads are stripped, and links require
HTTP(S). Conversation responses are not HTTP-cached.

Native mobile Copy now maps selected display rows back to their logical source,
preserving spaces, Unicode and actual newlines without adding display-wrap
newlines to commands/URLs. Verified tmux soft wraps join; explicit breaks remain.
Reformatted tables/status decorations retain their displayed representation when
copied; use the original conversation view for original message text. HTTP(S)
links spanning visual wraps keep their complete destination.

## Verification

Command tests check ownership, claims, the shared width and its relay to agents,
bounds, lease expiry, actual-size verification, remote client identity, legacy
compatibility and recovery without resizing.
Capture tests check a consistent screen/history/cursor. Renderer tests cover
stale frame rejection, desktop height, mobile wrapping of Hangul/emoji/combining
characters, natural word boundaries, verified soft-wrap metadata, cursor
remapping, font/width changes and removal of stale screen rows.
An isolated tmux/browser fixture compares the complete captured text to both
clients, including history and the rightmost columns, after desktop resizing,
phone rotation and mobile font changes. It also checks simultaneous phone viewers,
no horizontal overflow, and no source resize caused by phones. No real user
process receives test input.

The October 2 native mobile renderer is covered by DOM and actual terminal-core
tests, including live history caching, range retention, Unicode, status layout,
font/width changes and Enter/Send separation. Real browser/iPhone checks were not
run in this restricted container because they would require an unsafe sandbox
bypass; older browser checks listed above concern the previous renderer.
The native renderer and Enter/Send changes were deployed on October 2 as
`safe-mobile-security-20261002`; the served assets match the staged build.

October 4 adds copy/source mapping tests, safe wrapped links, transcript identity
and pagination tests, and synthetic Playwright phone/desktop cases under
`frontend/e2e`. The browser runner refuses root and requires the sandbox. Listing
those cases is not an execution result. Real iPhone momentum, native selection
handles, keyboard and rotation checks still require a connected device; no
unsafe browser fallback is permitted.
