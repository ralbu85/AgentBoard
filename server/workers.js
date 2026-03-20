const { execFile } = require("child_process");
const { isAlive, tmux, tmuxAsyncRaw } = require("./tmux");

const workers = new Map();
let nextId = 1;
let lastCapture = {};
let broadcastFn = () => {};

const IDLE_THRESHOLD = 5000;
const POLL_FAST = 500;
const POLL_SLOW = 5000;
const POLL_BASE = 300;

function setBroadcast(fn) { broadcastFn = fn; }
function getWorkers() { return workers; }
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

function spawnWorker(cwd, cmd) {
  const id = String(nextId++);
  const sessionName = "term-" + id;
  tmux(`new-session -d -s ${sessionName} -c "${cwd}"`);
  if (cmd) {
    tmux(`send-keys -t ${sessionName} ${JSON.stringify(cmd)} Enter`);
  }
  workers.set(id, { sessionName, cwd, cmd, logs: [], cols: 80, rows: 24 });
  broadcastFn({ type: "spawned", id, cwd, cmd, status: "running", sessionName });
  return id;
}

function killWorker(id) {
  const w = workers.get(id);
  if (!w) return false;
  tmux(`kill-session -t ${w.sessionName}`);
  w.status = 'stopped';
  w.aiState = null;
  broadcastFn({ type: "status", id, status: "stopped" });
  return true;
}

async function sendInput(id, text) {
  const w = workers.get(id);
  if (!w) return false;
  const lines = text.split("\n");
  for (const line of lines) {
    await tmuxAsyncRaw(["send-keys", "-t", w.sessionName, line.replace(/"/g, '\\"'), ""]);
    await tmuxAsyncRaw(["send-keys", "-t", w.sessionName, "", "Enter"]);
  }
  broadcastFn({ type: "log", id, src: "stdin", text, ts: Date.now() });
  setTimeout(() => pollOutput(id), 100);
  return true;
}

async function pollOutput(id) {
  const w = workers.get(id);
  if (!w) return;

  const alive = await new Promise(resolve => {
    execFile("tmux", ["has-session", "-t", w.sessionName], (err) => resolve(!err));
  });
  if (!alive) {
    w.status = 'completed';
    w.aiState = null;
    broadcastFn({ type: "status", id, status: "completed" });
    return;
  }

  const cols = w.cols || 80;
  const rows = w.rows || 50;

  const [, output, currentCwd] = await Promise.all([
    tmuxAsyncRaw(["resize-window", "-t", w.sessionName, "-x", String(cols), "-y", String(rows)]),
    tmuxAsyncRaw(["capture-pane", "-t", w.sessionName, "-p", "-e", "-S", "-100", "-J"]),
    tmuxAsyncRaw(["display-message", "-t", w.sessionName, "-p", "#{pane_current_path}|#{pane_current_command}|#{session_created}|#{pane_pid}"]),
  ]);

  const infoParts = currentCwd.trim().split("|");
  const trimmedCwd = infoParts[0] || "";
  const curProcess = infoParts[1] || "";
  const createdAt = parseInt(infoParts[2]) || 0;
  const panePid = infoParts[3] || "";

  if (trimmedCwd && trimmedCwd !== w.cwd) {
    w.cwd = trimmedCwd;
    broadcastFn({ type: "cwd", id, cwd: trimmedCwd });
  }

  if (!w._memTick) w._memTick = 0;
  w._memTick++;
  let memKB = w.memKB || 0;
  if (panePid && w._memTick % 30 === 0) {
    try {
      const psOut = await new Promise(resolve => {
        execFile("ps", ["-o", "rss=", "--pid", panePid, "--ppid", panePid], { encoding: "utf8", timeout: 3000 }, (err, stdout) => resolve(err ? "" : stdout));
      });
      memKB = psOut.trim().split(/\s+/).reduce((sum, v) => sum + (parseInt(v) || 0), 0);
    } catch (e) { memKB = 0; }
  }

  if (curProcess !== w.process || createdAt !== w.createdAt || memKB !== w.memKB) {
    w.process = curProcess;
    w.createdAt = createdAt;
    w.memKB = memKB;
    broadcastFn({ type: "info", id, process: curProcess, createdAt, memKB });
  }

  if (output === lastCapture[id]) {
    if (w.aiState !== 'idle' && w.aiState !== 'waiting' && w.lastChangeTime) {
      const elapsed = Date.now() - w.lastChangeTime;
      if (elapsed >= IDLE_THRESHOLD) {
        const waiting = detectWaiting(output);
        const newState = waiting ? 'waiting' : 'idle';
        if (newState !== w.aiState) {
          w.aiState = newState;
          broadcastFn({ type: "aiState", id, state: newState });
        }
      }
    }
    return;
  }

  lastCapture[id] = output;
  w.lastChangeTime = Date.now();
  const lines = output.split("\n");
  w.logs = lines.slice(-200).map(text => ({ src: "stdout", text, ts: Date.now() }));

  broadcastFn({ type: "snapshot", id, lines });

  const waiting = detectWaiting(output);
  const aiState = waiting ? 'waiting' : 'working';
  if (aiState !== w.aiState) {
    w.aiState = aiState;
    broadcastFn({ type: "aiState", id, state: aiState });
  }
}

async function pollAll() {
  const now = Date.now();
  const ids = [...workers.keys()];
  const toPoll = ids.filter(id => {
    const w = workers.get(id);
    if (!w) return false;
    const interval = (w.aiState === 'idle' || w.aiState === 'waiting' || w.status === 'stopped' || w.status === 'completed') ? POLL_SLOW : POLL_FAST;
    if (!w._lastPoll || now - w._lastPoll >= interval) {
      w._lastPoll = now;
      return true;
    }
    return false;
  });
  if (toPoll.length > 0) {
    await Promise.all(toPoll.map(id => pollOutput(id).catch(() => {})));
  }
  setTimeout(pollAll, POLL_BASE);
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
    if (workers.has(id)) continue;
    workers.set(id, { sessionName, cwd, cmd, logs: [], cols: 80, rows: 24 });
    if (numId >= nextId) nextId = numId + 1;
  }
  if (workers.size > 0) {
    console.log(`♻️  Recovered ${workers.size} session(s)`);
  }
}

module.exports = {
  workers, getWorkers, getNextId, setNextId,
  setBroadcast, spawnWorker, killWorker, sendInput,
  pollOutput, pollAll, recoverSessions, lastCapture
};
