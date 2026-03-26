// ── PTY Streamer ──
// Initial: capture-pane snapshot
// Live: pipe-pane → file → tail -f → broadcast

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { tmuxAsyncRaw } = require("./tmux");
const { sessions, detectState } = require("./sessions");

let broadcastFn = () => {};
let activeSessionId = null;
const streams = {};  // id → { tail, file }

const STATE_POLL_MS = 2000;

function setBroadcast(fn) { broadcastFn = fn; }
function setActiveSession(id) { activeSessionId = id; }

// Snapshot for initial load
async function getSnapshot(id) {
  const s = sessions.get(id);
  if (!s) return null;

  const cols = s.cols || 80;
  const rows = s.rows || 50;

  await tmuxAsyncRaw(["resize-window", "-t", s.sessionName, "-x", String(cols), "-y", String(rows)]);

  const [output, info] = await Promise.all([
    tmuxAsyncRaw(["capture-pane", "-t", s.sessionName, "-p", "-e", "-S", "-500"]),
    tmuxAsyncRaw(["display-message", "-t", s.sessionName, "-p",
      "#{pane_current_path}|#{pane_current_command}|#{session_created}|#{pane_pid}"])
  ]);

  _updateInfo(id, s, info);
  _detectState(id, s, output);

  return output;
}

// Start live stream
function startStream(id) {
  if (streams[id]) return;
  const s = sessions.get(id);
  if (!s) return;

  const file = path.join(os.tmpdir(), 'ab-stream-' + id);

  // Clear file
  fs.writeFileSync(file, '');

  // Tell tmux to pipe to file
  tmuxAsyncRaw(["pipe-pane", "-t", s.sessionName, "cat >> " + file]);

  // Tail the file
  const tail = spawn("tail", ["-f", "-n", "0", file], { stdio: ['ignore', 'pipe', 'ignore'] });

  tail.stdout.on('data', function(chunk) {
    var data = chunk.toString();
    if (data) {
      broadcastFn({ type: 'stream', id: id, data: data });
    }
  });

  tail.on('close', function() {
    // Restart if died
    delete streams[id];
  });

  streams[id] = { tail: tail, file: file };
}

function stopStream(id) {
  const st = streams[id];
  if (!st) return;
  const s = sessions.get(id);
  if (s) {
    tmuxAsyncRaw(["pipe-pane", "-t", s.sessionName]); // stop piping
  }
  try { st.tail.kill(); } catch (e) {}
  try { fs.unlinkSync(st.file); } catch (e) {}
  delete streams[id];
}

function stopAllStreams() {
  Object.keys(streams).forEach(stopStream);
}

// Lightweight state polling (capture last 5 lines only)
function _updateInfo(id, s, infoStr) {
  const parts = infoStr.trim().split("|");
  const cwd = parts[0] || "";
  const curProcess = parts[1] || "";
  const createdAt = parseInt(parts[2]) || 0;

  if (cwd && cwd !== s.cwd) {
    s.cwd = cwd;
    broadcastFn({ type: "cwd", id, cwd });
  }
  if (curProcess !== s.process || createdAt !== s.createdAt) {
    s.process = curProcess;
    s.createdAt = createdAt;
    broadcastFn({ type: "info", id, process: curProcess, createdAt, memKB: s.memKB || 0 });
  }
}

function _detectState(id, s, output) {
  const newState = detectState(output, s.process || "");
  if (newState !== s.aiState) {
    s.aiState = newState;
    broadcastFn({ type: "aiState", id, state: newState });
  }
}

async function pollStates() {
  for (const [id, s] of sessions.entries()) {
    if (s.status === 'stopped') continue;
    try {
      const alive = await new Promise(resolve => {
        execFile("tmux", ["has-session", "-t", s.sessionName], err => resolve(!err));
      });
      if (!alive) {
        if (s.status !== 'completed') {
          s.status = 'completed'; s.aiState = null;
          broadcastFn({ type: "status", id, status: "completed" });
          stopStream(id);
        }
        continue;
      }
      const [info, tail] = await Promise.all([
        tmuxAsyncRaw(["display-message", "-t", s.sessionName, "-p",
          "#{pane_current_path}|#{pane_current_command}|#{session_created}|#{pane_pid}"]),
        tmuxAsyncRaw(["capture-pane", "-t", s.sessionName, "-p", "-S", "-5"])
      ]);
      _updateInfo(id, s, info);
      _detectState(id, s, tail);
    } catch (e) {}
  }
  setTimeout(pollStates, STATE_POLL_MS);
}

module.exports = { setBroadcast, setActiveSession, getSnapshot, startStream, stopStream, stopAllStreams, pollStates };
