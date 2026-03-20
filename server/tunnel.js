const { execSync, spawn } = require("child_process");

let tunnelUrl = null;
let tunnelProcess = null;
let broadcastFn = () => {};

function setBroadcast(fn) { broadcastFn = fn; }
function getTunnelUrl() { return tunnelUrl; }

function startTunnel(port, discordWebhook) {
  try {
    execSync("which cloudflared", { stdio: "pipe" });
  } catch {
    console.log("☁️  cloudflared not found — skipping tunnel");
    return;
  }
  tunnelProcess = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handleData = (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
    if (match && !tunnelUrl) {
      tunnelUrl = match[0];
      console.log(`☁️  Tunnel URL → ${tunnelUrl}`);
      broadcastFn({ type: "tunnel", url: tunnelUrl });
      if (discordWebhook) {
        fetch(discordWebhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `☁️ AgentBoard → ${tunnelUrl}` }),
        }).catch(() => {});
      }
    }
  };
  tunnelProcess.stdout.on("data", handleData);
  tunnelProcess.stderr.on("data", handleData);
  tunnelProcess.on("close", (code) => {
    console.log(`☁️  cloudflared exited (code ${code}), restarting in 5s...`);
    tunnelUrl = null;
    tunnelProcess = null;
    setTimeout(() => startTunnel(port, discordWebhook), 5000);
  });
}

function checkTunnel() {
  if (!tunnelUrl) return;
  fetch(tunnelUrl, { signal: AbortSignal.timeout(10000) })
    .then(r => { if (!r.ok) throw new Error(r.status); })
    .catch(() => {
      console.log("☁️  Tunnel health check failed, restarting...");
      if (tunnelProcess) tunnelProcess.kill();
    });
}

function cleanup() {
  if (tunnelProcess) tunnelProcess.kill();
}

module.exports = { setBroadcast, getTunnelUrl, startTunnel, checkTunnel, cleanup };
