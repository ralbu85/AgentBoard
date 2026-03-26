require("dotenv").config({ path: require("path").join(__dirname, '..', '..', '.env') });
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const { tmuxAsyncRaw } = require("./tmux");
const { sessions, setBroadcast: setSessionsBroadcast, recoverSessions, sessionTitles, saveSessionTitles } = require("./sessions");
const streamer = require("./streamer");
const { setupRoutes } = require("./routes");
const tunnel = require("./tunnel");

// ── Config ──

const PORT = process.env.V2_PORT || 3001;
const PASSWORD = process.env.DASHBOARD_PASSWORD || "changeme";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

if (PASSWORD === "changeme") {
  console.warn("Using default password. Set DASHBOARD_PASSWORD in .env");
}

const AUTH_TOKEN = crypto.createHmac("sha256", "termhub").update(PASSWORD).digest("hex");

function loadConfig() {
  const configPath = path.join(__dirname, '..', '..', "config.json");
  return fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
}

function auth(req) {
  const cookie = req.headers.cookie || "";
  const token = cookie.split(";").map(s => s.trim()).find(s => s.startsWith("token="))?.slice(6);
  return token === AUTH_TOKEN;
}

// ── Server ──

const server = http.createServer();
let wss;

function broadcast(obj) {
  if (!wss) return;
  var msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

setSessionsBroadcast(broadcast);
streamer.setBroadcast(broadcast);
tunnel.setBroadcast(broadcast);

setupRoutes(server, { auth, broadcast, PASSWORD, AUTH_TOKEN, loadConfig });

// ── WebSocket ──

wss = new WebSocketServer({ server });
const clientSizes = new Map();

wss.on('connection', ws => {
  if (Object.keys(sessionTitles).length > 0) {
    ws.send(JSON.stringify({ type: "titles", titles: sessionTitles }));
  }

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'resize') {
        clientSizes.set(ws, { cols: msg.cols, rows: msg.rows });
        if (msg.id) {
          const s = sessions.get(msg.id);
          if (s) { s.cols = msg.cols; s.rows = msg.rows; }
        } else {
          sessions.forEach(s => { s.cols = msg.cols; s.rows = msg.rows; });
        }
      }

      if (msg.type === 'active') {
        streamer.setActiveSession(msg.id || null);
        const size = clientSizes.get(ws);
        if (size) {
          sessions.forEach(s => { s.cols = size.cols; s.rows = size.rows; });
        }
        if (msg.id) {
          // Send snapshot + start streaming
          streamer.getSnapshot(msg.id).then(output => {
            if (output) {
              ws.send(JSON.stringify({ type: 'snapshot', id: msg.id, data: output }));
            }
            streamer.startStream(msg.id);
          });
        }
      }

      if (msg.type === 'resync') {
        if (msg.id) {
          streamer.getSnapshot(msg.id).then(output => {
            if (output) {
              ws.send(JSON.stringify({ type: 'snapshot', id: msg.id, data: output }));
            }
          });
        }
      }

      if (msg.type === 'title') {
        if (msg.id) {
          if (msg.title) sessionTitles[msg.id] = msg.title;
          else delete sessionTitles[msg.id];
          saveSessionTitles();
          broadcast({ type: "title", id: msg.id, title: msg.title || null });
        }
      }

      if (msg.type === 'key') {
        const s = sessions.get(msg.id);
        if (s) tmuxAsyncRaw(["send-keys", "-t", s.sessionName, msg.key]);
      }

      if (msg.type === 'terminal-input') {
        const s = sessions.get(msg.id);
        if (s && msg.data) {
          const SEQ_MAP = {
            '\r': 'Enter', '\x1b': 'Escape', '\t': 'Tab',
            '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
            '\x7f': 'BSpace', '\x08': 'BSpace',
            '\x03': 'C-c', '\x04': 'C-d', '\x1a': 'C-z',
            '\x1b[H': 'Home', '\x1b[F': 'End',
            '\x1b[5~': 'PageUp', '\x1b[6~': 'PageDown',
            '\x1b[3~': 'DC',
          };
          if (SEQ_MAP[msg.data]) {
            tmuxAsyncRaw(["send-keys", "-t", s.sessionName, SEQ_MAP[msg.data]]);
          } else {
            tmuxAsyncRaw(["send-keys", "-t", s.sessionName, "-l", msg.data]);
          }
        }
      }

      if (msg.type === 'input') {
        const s = sessions.get(msg.id);
        if (s) {
          (async () => {
            const lines = msg.text.split("\n");
            for (const line of lines) {
              await tmuxAsyncRaw(["send-keys", "-t", s.sessionName, line.replace(/"/g, '\\"'), ""]);
              await tmuxAsyncRaw(["send-keys", "-t", s.sessionName, "", "Enter"]);
            }
            broadcast({ type: "log", id: msg.id, src: "stdin", text: msg.text, ts: Date.now() });
          })();
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => { clientSizes.delete(ws); });
});

// ── Start ──

server.listen(PORT, () => {
  recoverSessions();
  // Start streaming for all existing sessions
  sessions.forEach((s, id) => { streamer.startStream(id); });
  // Lightweight state polling (no capture-pane, just process check + last 5 lines)
  streamer.pollStates();
  console.log(`AgentBoard v2 running on http://localhost:${PORT}`);
  console.log(`Password: ${PASSWORD}`);
  tunnel.startTunnel(PORT, DISCORD_WEBHOOK);
  setInterval(() => tunnel.checkTunnel(), 60000);
});

process.on("SIGINT", () => { streamer.stopAllStreams(); tunnel.cleanup(); process.exit(); });
process.on("SIGTERM", () => { streamer.stopAllStreams(); tunnel.cleanup(); process.exit(); });
