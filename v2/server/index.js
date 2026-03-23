require("dotenv").config({ path: require("path").join(__dirname, '..', '..', '.env') });
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const { tmuxAsyncRaw } = require("./tmux");
const { sessions, setBroadcast: setSessionsBroadcast, recoverSessions, sessionTitles, saveSessionTitles } = require("./sessions");
const { setBroadcast: setPollerBroadcast, setActiveSession, pollOutput, pollAll, lastCapture } = require("./poller");
const { setupRoutes } = require("./routes");
const tunnel = require("./tunnel");

// ── Config ──

const PORT = process.env.V2_PORT || process.env.PORT || 3001;
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
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// Wire up broadcast
setSessionsBroadcast(broadcast);
setPollerBroadcast(broadcast);
tunnel.setBroadcast(broadcast);

// Setup HTTP routes
setupRoutes(server, { auth, broadcast, PASSWORD, AUTH_TOKEN, loadConfig });

// ── WebSocket ──

wss = new WebSocketServer({ server });
const clientSizes = new Map();

wss.on('connection', ws => {
  // Don't send cached output on connect — wait for client to send resize+active
  // so tmux gets resized first and capture-pane output matches xterm cols.
  // Only send titles on connect.
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
        setActiveSession(msg.id || null);
        const size = clientSizes.get(ws);
        if (size) {
          // Apply client size to ALL sessions so background sessions
          // get resized too (prevents stale 293+ cols from v1)
          sessions.forEach(s => { s.cols = size.cols; s.rows = size.rows; });
        }
        if (msg.id) {
          // Clear cached capture so next poll sends fresh output at new size
          delete lastCapture[msg.id];
          pollOutput(msg.id).catch(() => {});
        }
      }

      if (msg.type === 'resync') {
        if (msg.id) {
          // Clear cache and re-poll at current (resized) dimensions
          delete lastCapture[msg.id];
          pollOutput(msg.id).catch(() => {});
        }
      }

      if (msg.type === 'title') {
        if (msg.id) {
          if (msg.title) {
            sessionTitles[msg.id] = msg.title;
          } else {
            delete sessionTitles[msg.id];
          }
          saveSessionTitles();
          broadcast({ type: "title", id: msg.id, title: msg.title || null });
        }
      }

      if (msg.type === 'key') {
        const s = sessions.get(msg.id);
        if (s) {
          tmuxAsyncRaw(["send-keys", "-t", s.sessionName, msg.key]).then(() => {
            setTimeout(() => pollOutput(msg.id), 100);
          });
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
            setTimeout(() => pollOutput(msg.id), 100);
          })();
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => clientSizes.delete(ws));
});

// ── Start ──

server.listen(PORT, () => {
  recoverSessions();
  pollAll();
  console.log(`AgentBoard v2 running on http://localhost:${PORT}`);
  console.log(`Password: ${PASSWORD}`);
  tunnel.startTunnel(PORT, DISCORD_WEBHOOK);
  setInterval(() => tunnel.checkTunnel(), 60000);
});

process.on("SIGINT", () => { tunnel.cleanup(); process.exit(); });
process.on("SIGTERM", () => { tunnel.cleanup(); process.exit(); });
