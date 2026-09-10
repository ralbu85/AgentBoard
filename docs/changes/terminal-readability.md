# Workbench and readability — 2026-09-10

The layout is workspace/session overview | independent file explorer | unified terminal/file tabs. Each session remains visible in its workspace; selecting it opens its terminal tab. Closing a terminal tab keeps its process alive. Manual session names take precedence over the automatic tmux pane title; sessions without either show a command/id fallback.

Workspace handles and viewer tabs support drag reordering. Workspace removal still asks for confirmation and keeps the underlying directory and sessions. Tab order and last selected workspace/file persist in this browser. PDF page/zoom, editor scroll/cursor, document scroll, expanded folders and explorer scroll are restored. File positions also survive closing and reopening a tab. Unsaved file contents are intentionally not stored in localStorage; closing dirty tabs or leaving the app requires confirmation.

## Colors and completion review

Workspace groups have dark headers, visible borders and spacing. Selection uses a dark violet tint and a narrow accent edge. Secondary labels have higher contrast. Completion markers appear only in the left workspace overview. Clicking a session or its terminal tab clears its marker; clicking a workspace's completion count clears that workspace's markers. A later completion marks the session again. Automatic selection and reload do not acknowledge results. Markers are browser-local and depend on received status transitions; agent state detection remains heuristic.

## Applied readability changes

- Terminal default 15px, line height 1.25, no automatic font shrinking. A− / A+ / reset controls persist 12–22px preferences.
- Adaptive width uses 30–80 columns within the existing server protocol; a fixed 80-column option remains available.
- Brighter ANSI gray and minimum text contrast 4.5. The toolbar stays above terminal output.
- PDF current/total page display, page slider, previous/next buttons, zoom and reload preserving the current page. Canvas painting is limited to pages near the viewport.

## Validation

Frontend store/readability/terminal/API tests and backend tests pass. Isolated Chromium checks cover unified tabs, automatic titles, PDF slider/page restoration, document/editor scroll restoration, workspace/tab drag ordering, reload persistence, click-to-clear sidebar markers and mobile file viewing. Production tmux sessions are preserved when the app server restarts.
