// Server-side line buffer per session
// Accumulates output, sends diffs to clients
// Single source of truth — mobile and desktop get identical data

const MAX_LINES = 5000;
const buffers = {}; // id → { lines: string[], version: number }

function getBuffer(id) {
  if (!buffers[id]) buffers[id] = { lines: [], version: 0 };
  return buffers[id];
}

// Update buffer from capture-pane output, return diff
function update(id, captureOutput) {
  const buf = getBuffer(id);
  const newLines = captureOutput.split('\n');

  if (buf.lines.length === 0) {
    // First capture
    buf.lines = newLines;
    buf.version++;
    return { type: 'full', lines: newLines, version: buf.version };
  }

  // Find overlap — strip ANSI for reliable comparison
  const strip = s => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const lastBufStripped = strip(buf.lines[buf.lines.length - 1]);
  let matchIdx = -1;
  for (let i = newLines.length - 1; i >= 0; i--) {
    if (strip(newLines[i]) === lastBufStripped) {
      let ok = true;
      for (let c = 1; c <= Math.min(5, i, buf.lines.length - 1); c++) {
        if (strip(newLines[i - c]) !== strip(buf.lines[buf.lines.length - 1 - c])) { ok = false; break; }
      }
      if (ok) { matchIdx = i; break; }
    }
  }

  if (matchIdx === -1) {
    // No overlap — content completely changed (screen clear, etc.)
    buf.lines = newLines;
    buf.version++;
    return { type: 'full', lines: newLines, version: buf.version };
  }

  const appended = newLines.slice(matchIdx + 1);
  if (appended.length === 0) return null; // nothing changed

  buf.lines = buf.lines.concat(appended);
  // Cap buffer
  if (buf.lines.length > MAX_LINES) buf.lines = buf.lines.slice(-MAX_LINES);
  buf.version++;

  return { type: 'append', lines: appended, version: buf.version };
}

function getLines(id) {
  return getBuffer(id).lines;
}

function clear(id) {
  delete buffers[id];
}

module.exports = { update, getLines, getBuffer, clear };
