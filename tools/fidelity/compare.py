"""Compare the headless-xterm render against tmux ground truth."""
import json, re, sys

OUT = str(__import__('pathlib').Path(__file__).resolve().parent)
truth = json.load(open(f"{OUT}/truth.json"))
r = json.load(open(f"{OUT}/rendered.json"))

fails = []

def norm_block(text_lines):
    lines = [l.rstrip() for l in text_lines]
    while lines and not lines[-1]:
        lines.pop()
    return lines

# ── 1. Visible area: last `rows` lines of the xterm buffer vs capture-pane ──
viewport = r["lines"][r["baseY"]: r["baseY"] + r["rows"]]
xterm_vis = norm_block(viewport)
tmux_vis = norm_block(truth["visible"].split("\n"))
if xterm_vis == tmux_vis:
    print(f"PASS visible area: {len(tmux_vis)} lines identical")
else:
    fails.append("visible")
    print(f"FAIL visible area: xterm={len(xterm_vis)} tmux={len(tmux_vis)} lines")
    for i, (a, b) in enumerate(zip(xterm_vis, tmux_vis)):
        if a != b:
            print(f"  first diff at line {i}:\n    xterm: {a!r}\n    tmux : {b!r}")
            break
    if len(xterm_vis) != len(tmux_vis):
        print(f"  extra: {(xterm_vis[len(tmux_vis):] or tmux_vis[len(xterm_vis):])[:3]!r}")

# ── 2. Burst continuity: every line 1..500 must exist somewhere in the buffer ──
nums = set()
for l in r["lines"]:
    m = re.fullmatch(r"\s*(\d{1,3})\s*", l)
    if m:
        nums.add(int(m.group(1)))
missing = [n for n in range(1, 501) if n not in nums]
if not missing:
    print("PASS burst continuity: all 500 lines present in scrollback+viewport")
else:
    fails.append("burst")
    print(f"FAIL burst continuity: {len(missing)} lines missing, e.g. {missing[:10]}")

# ── 3. Special characters survived the pipeline ──
buf_text = "\n".join(r["lines"])
for token in ["한글 테스트", "🚀", "émoji", "─┐│└", "RED", "BOLD-BLUE", "PROMPT-EDGE>"]:
    if token in buf_text:
        print(f"PASS content token: {token!r}")
    else:
        fails.append(f"token:{token}")
        print(f"FAIL content token missing: {token!r}")

# ── 4. Cursor position vs tmux ──
cx, cy, cflag, hist = truth["cursor"].split(";")
if (r["cursorX"], r["cursorY"]) == (int(cx), int(cy)):
    print(f"PASS cursor position: ({cx},{cy})")
else:
    fails.append("cursor")
    print(f"FAIL cursor: xterm=({r['cursorX']},{r['cursorY']}) tmux=({cx},{cy})")

# ── 5. Deep-history tail: what tmux still holds vs what the client got ──
tmux_deep = norm_block(truth["deep"].split("\n"))
xterm_all = norm_block(r["lines"])
tail_n = min(len(tmux_deep), len(xterm_all), 300)
if xterm_all[-tail_n:] == tmux_deep[-tail_n:]:
    print(f"PASS deep-history tail: last {tail_n} lines identical to tmux history")
else:
    fails.append("deep")
    a, b = xterm_all[-tail_n:], tmux_deep[-tail_n:]
    idx = next(i for i, (x, y) in enumerate(zip(a, b)) if x != y)
    print(f"FAIL deep-history tail diverges at -{tail_n - idx}:")
    print(f"    xterm: {a[idx]!r}\n    tmux : {b[idx]!r}")

print()
print(f"tmux history_size at capture: {hist}")
print("RESULT:", "ALL PASS ✅" if not fails else f"FAILURES: {fails}")
sys.exit(1 if fails else 0)
