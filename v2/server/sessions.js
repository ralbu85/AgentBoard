const fs = require("fs");
const path = require("path");
const { isAlive, tmux, tmuxAsyncRaw } = require("./tmux");

const sessions = new Map();
let nextId = 1;
let broadcastFn = () => {};

// Session titles — persisted to disk
const TITLES_FILE = path.join(__dirname, '..', '.session-titles.json');
let sessionTitles = {};
try { sessionTitles = JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8')); } catch (e) {}

function saveSessionTitles() {
  try { fs.writeFileSync(TITLES_FILE, JSON.stringify(sessionTitles), 'utf8'); } catch (e) {}
}

function setBroadcast(fn) { broadcastFn = fn; }
function getNextId() { return nextId; }
function setNextId(n) { nextId = n; }

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function detectWaiting(output) {
  const lines = output.split("\n");
  const recent = stripAnsi(lines.slice(-10).join("\n"));
  if (/Esc to cancel/.test(recent)) return true;
  if (/Do you want to proceed\?/.test(recent)) return true;
  if (/❯\s*\d+\.\s*(Yes|No)/.test(recent)) return true;
  if (/Allow/.test(recent) && /\?/.test(recent)) return true;
  if (/\([Yy]\/[Nn]\)/.test(recent) || /\[[Yy]\/[Nn]\]/.test(recent) || /\[[yY]\/[nN]\]/.test(recent)) return true;
  if (/approve|confirm|accept/i.test(recent) && /\?/.test(recent)) return true;
  return false;
}

function detectState(out, process) {
  const shells = ['bash', 'zsh', 'sh', 'fish', 'dash', 'csh', 'tcsh', 'tmux', 'login'];
  if (shells.indexOf(process) !== -1) return 'idle';
  if (detectWaiting(out)) return 'waiting';
  var stripped = stripAnsi(out);
  var lines = stripped.split("\n");

  // Simplest detection: Claude CLI status bar (last 3 lines)
  //   WORKING: "esc to interrupt" present
  //   IDLE:    "esc to interrupt" absent
  var last3 = lines.slice(-3).join(" ");
  if (/esc to interrupt/i.test(last3)) {
    return 'working';
  }
  // Has ❯ prompt = idle
  var last10 = lines.slice(-10);
  if (last10.some(function(l) { return /^\s*❯/.test(l); })) {
    return 'idle';
  }
  return 'working';
}

function spawnSession(cwd, cmd) {
  const id = String(nextId++);
  const sessionName = "term-" + id;
  tmux(`new-session -d -s ${sessionName} -c "${cwd}"`);
  try { tmux(`set-option -t ${sessionName} history-limit 10000`); } catch (e) {}
  if (cmd) {
    tmux(`send-keys -t ${sessionName} ${JSON.stringify(cmd)} Enter`);
  }
  sessions.set(id, { sessionName, cwd, cmd, cols: 80, rows: 24, aiState: 'working', status: 'running' });
  broadcastFn({ type: "spawned", id, cwd, cmd, status: "running", sessionName });
  return id;
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  tmux(`kill-session -t ${s.sessionName}`);
  s.status = 'stopped';
  s.aiState = null;
  broadcastFn({ type: "status", id, status: "stopped" });
  return true;
}

async function sendInput(id, text) {
  const s = sessions.get(id);
  if (!s) return false;
  const lines = text.split("\n");
  for (const line of lines) {
    await tmuxAsyncRaw(["send-keys", "-t", s.sessionName, "-l", line]);
    await tmuxAsyncRaw(["send-keys", "-t", s.sessionName, "Enter"]);
  }
  broadcastFn({ type: "log", id, src: "stdin", text, ts: Date.now() });
  return true;
}

function recoverSessions() {
  const raw = tmux("ls -F '#{session_name}|#{pane_current_path}|#{pane_current_command}'");
  if (!raw.trim()) return;
  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("|");
    const sessionName = parts[0];
    const cwd = parts[1] || "unknown";
    const cmd = parts[2] || "unknown";
    if (!sessionName.startsWith("term-")) continue;
    const id = sessionName.replace("term-", "");
    const numId = parseInt(id);
    if (isNaN(numId)) continue;
    if (sessions.has(id)) continue;
    try { tmux(`set-option -t ${sessionName} history-limit 10000`); } catch (e) {}
    const shellProcesses = ['bash', 'zsh', 'sh', 'fish', 'dash', 'csh', 'tcsh', 'tmux', 'login'];
    let initAiState = 'working';
    if (shellProcesses.indexOf(cmd) !== -1) {
      initAiState = 'idle';
    } else {
      try {
        const snap = tmux(`capture-pane -t ${sessionName} -p -S -50`);
        const testState = detectState(snap, cmd);
        if (testState === 'idle') initAiState = 'idle';
      } catch (e) {}
    }
    sessions.set(id, { sessionName, cwd, cmd, cols: 80, rows: 24, aiState: initAiState, status: 'running' });
    if (numId >= nextId) nextId = numId + 1;
  }
  if (sessions.size > 0) {
    console.log(`Recovered ${sessions.size} session(s)`);
  }
}

module.exports = {
  sessions, getNextId, setNextId,
  setBroadcast, spawnSession, killSession, sendInput,
  recoverSessions, detectState, sessionTitles, saveSessionTitles
};
