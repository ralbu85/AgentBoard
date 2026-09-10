# Terminal readability review — 2026-09-10

The desktop layout is now: persistent workspace overview | file explorer | terminal / optional viewer. The two navigation columns are independently resizable. Closing the explorer does not close the workspace overview. Workspace ordering, confirmed removal and restoration remain available.

## Completion review

A working → idle transition, or a new process-completed event, adds a persistent cyan “미확인” marker to the session, workspace aggregate and header. The marker is independent of the live working/waiting state. Automatic selection and reload do not acknowledge it. Clicking the session tab, grid tile, the session manager's Open button, or the explicit “완료 · 확인” button acknowledges that session. Later completions mark it again.

Markers are stored in this browser. They reflect status transitions received by this client; completion events while the app is closed are not reconstructed. Agent completion detection remains heuristic (terminal output), so a quiet agent can still be misclassified.

## Findings and recommended next changes

Measured in Chromium with the two default navigation columns (280px + 240px) and a terminal/viewer split of 55% / 45%, at 960px viewport height:

| Viewport width | Terminal width | Rendered font size |
| --- | --- | --- |
| 1280px | 413px | 10px |
| 1440px | 501px | 12px |
| 1920px | 765px | 12px |

These are measurements of a controlled sample session, not every possible terminal layout.

1. **Automatic font shrinking is the principal problem.** `TerminalManager` targets 12px, preserves 80 columns on desktop, and allows shrinking to 8px. The second navigation column and a viewer exacerbate this on smaller screens. Recommend a readable mode targeting 14–16px with a 12px minimum, plus explicit A− / A+ / reset controls and persisted preferences. At 16px an 80-column D2Coding terminal needs approximately 640px of text width; increasing the target alone will not help while the fit logic keeps shrinking it. Offer adaptive column count or a focus view, retaining 80-column mode for TUIs that require it. Verify tmux/xterm alignment and multi-client resize behavior before changing this policy.
2. **Dense lines.** No custom line-height is configured. Recommend evaluating 1.2–1.3 line height using actual multiline output, code tables, CJK and box-drawing fixtures. Keep letter spacing zero and preserve the current font's two-cell Hangul behavior.
3. **Dim ANSI text is difficult to read.** Current normal text `#ececf1` against `#101014` has a computed contrast ratio of 16.12:1, but bright-black `#5c5c6e` is only 2.90:1 (black `#3b3b4f`: 1.74:1). Recommend a brighter dim-text palette or optional contrast mode, while keeping syntax/state colors distinguishable. Agent-provided truecolor/dim escape sequences also need inspection; changing the palette alone does not override all output styling.
4. **Toolbar overlap.** The old absolute-positioned state badge and log button covered the first output lines. Fixed in this change by moving them, and the new review button, to a separate toolbar above the terminal viewport.
5. **Reading vs monitoring.** Keep compact grids for monitoring, but provide one-click terminal focus for reading, independently folding the file explorer and viewer while preserving the workspace status overview. Long logs can continue to use the existing full-log viewer.

Font size, line-height, palette and 80-column policy are evaluated here; their defaults have not been changed in this revision.
