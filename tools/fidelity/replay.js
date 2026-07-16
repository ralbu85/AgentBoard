// Replay collected frames through headless xterm EXACTLY like the client does
// (TerminalManager._applySnapshot / writeScreen prefixes), then dump the final
// buffer + cursor for comparison against tmux ground truth.
const fs = require('fs')
const { Terminal } = require('@xterm/headless')

const { frames } = JSON.parse(fs.readFileSync(__dirname + '/frames.json', 'utf8'))
const term = new Terminal({ cols: 80, rows: 40, scrollback: 10000, allowProposedApi: true })
try {
  const { Unicode11Addon } = require('@xterm/addon-unicode11')
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
} catch { /* addon not installed — fall back to default width tables */ }

let chain = Promise.resolve()
for (const f of frames) {
  const prefix = f.type === 'snapshot' ? '\x1b[3J\x1b[2J\x1b[H' : '\x1b[2J\x1b[H'
  chain = chain.then(() => new Promise(res => term.write(prefix + f.data, res)))
}

chain.then(() => {
  const b = term.buffer.active
  const lines = []
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true))
  fs.writeFileSync(__dirname + '/rendered.json', JSON.stringify({
    lines, baseY: b.baseY, rows: 40,
    cursorX: b.cursorX, cursorY: b.cursorY,
  }))
  console.error(`rendered: ${lines.length} buffer lines, baseY=${b.baseY}, cursor=(${b.cursorX},${b.cursorY})`)
})
