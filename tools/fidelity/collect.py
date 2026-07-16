"""E2E fidelity collector.

Spawns a real session through the running AgentBoard server, views it over the
real WS protocol (so frames arrive exactly as a browser would receive them),
drives content through the real input API, then records:
  - every snapshot/screen frame received (in order)
  - ground truth straight from tmux (visible pane, deep history, cursor)
"""
import asyncio, json, subprocess, sys, urllib.request

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent.parent))
import websockets
from backend import config

BASE = "http://127.0.0.1:3002"
OUT = str(__import__("pathlib").Path(__file__).resolve().parent)


def rest(path, body):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Cookie": f"token={config.AUTH_TOKEN}"})
    return json.loads(urllib.request.urlopen(req).read())


def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True).stdout


async def main():
    spawn = rest("/api/spawn", {"cwd": "/tmp", "cmd": "bash", "host": "local"})
    sid = spawn["id"]
    name = f"term-{sid}"
    print(f"spawned session {sid}", file=sys.stderr)
    frames = []
    try:
        async with websockets.connect(
                "ws://127.0.0.1:3002/ws",
                additional_headers={"Cookie": f"token={config.AUTH_TOKEN}"}) as ws:

            async def drain(quiet_s):
                """Collect frames until `quiet_s` of silence."""
                while True:
                    try:
                        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=quiet_s))
                    except asyncio.TimeoutError:
                        return
                    if msg.get("id") == sid and msg.get("type") in ("snapshot", "screen"):
                        frames.append({"type": msg["type"], "data": msg["data"]})

            await ws.send(json.dumps({"type": "active", "id": sid}))
            await drain(2.0)  # initial snapshot

            # Stage A: colors + Korean + emoji + box drawing (width fidelity)
            rest("/api/input", {"id": sid, "text":
                "printf '\\e[31mRED\\e[0m \\e[1;34mBOLD-BLUE\\e[0m plain\\n한글 테스트 🚀 émoji ─┐│└ box\\n'"})
            await drain(2.0)

            # Stage B: burst — 500 lines fast (exercises growth snapshots)
            rest("/api/input", {"id": sid, "text": "seq 1 500"})
            await drain(2.5)

            # Stage C: partial-line cursor (no trailing newline)
            rest("/api/input", {"id": sid, "text": "printf 'PROMPT-EDGE> '"})
            await drain(2.5)

            # ── Ground truth, captured only after the stream went quiet ──
            visible = tmux("capture-pane", "-t", name, "-p")
            deep = tmux("capture-pane", "-t", name, "-p", "-S", "-2000")
            cur = tmux("display-message", "-t", name, "-p",
                       "#{cursor_x};#{cursor_y};#{cursor_flag};#{history_size}")
            json.dump({"frames": frames}, open(f"{OUT}/frames.json", "w"))
            json.dump({"visible": visible, "deep": deep, "cursor": cur.strip()},
                      open(f"{OUT}/truth.json", "w"))
            print(f"collected {len(frames)} frames "
                  f"({sum(1 for f in frames if f['type']=='snapshot')} snapshots)", file=sys.stderr)
    finally:
        rest("/api/kill", {"id": sid})
        rest("/api/remove", {"id": sid})
        print("session cleaned up", file=sys.stderr)

asyncio.run(main())
