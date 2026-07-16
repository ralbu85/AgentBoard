// Record two viewer-feature clips:
//  1) file panel: upload → markdown render + checkbox toggle → code edit + save
//  2) review loop: select code → memo → send to the agent's terminal
const { chromium } = require('playwright-core')
const crypto = require('crypto')
const TOKEN = crypto.createHmac('sha256', 'termhub').update('demo-shots-1').digest('hex')
const OUT = __dirname + '/video2'

async function newPage(browser, name) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 860 },
    recordVideo: { dir: OUT, size: { width: 1440, height: 860 } },
  })
  await ctx.addCookies([{ name: 'token', value: TOKEN, url: 'http://127.0.0.1:13002' }])
  const p = await ctx.newPage()
  await p.addInitScript(() => localStorage.setItem('agentboard.viewMode', 'single'))
  await p.goto('http://127.0.0.1:13002/', { waitUntil: 'networkidle' })
  await p.waitForTimeout(1500)
  // make the bash session ("review & fixes") active — it's the memo target and
  // a calm backdrop for the file work
  await p.locator('.session-tab', { hasText: 'review & fixes' }).first().click()
  await p.waitForTimeout(1000)
  return { ctx, p }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })

  // ── Clip 1: files tour ──
  {
    const { ctx, p } = await newPage(browser)
    await p.locator('.wb-files-btn').click()                    // open file panel
    await p.waitForTimeout(1500)
    await p.locator('.workspace-files input[type="file"]').setInputFiles(__dirname + '/design-tokens.json')
    await p.waitForTimeout(1800)                                // upload lands in the tree
    await p.locator('.tree-row.tree-file', { hasText: 'README.md' }).first().click()
    await p.waitForTimeout(2200)                                // rendered markdown opens
    const boxes = p.locator('.md-rendered input[type="checkbox"]')
    await boxes.nth(1).click()                                  // toggle a task → saves
    await p.waitForTimeout(1600)
    await p.locator('.tree-row.tree-dir', { hasText: 'src' }).first().click()
    await p.waitForTimeout(900)
    await p.locator('.tree-row.tree-file', { hasText: 'auth.ts' }).first().click()
    await p.waitForTimeout(2000)                                // code editor opens
    // add a comment line at the top of the file
    await p.locator('.cm-content').click({ position: { x: 200, y: 12 } })
    await p.keyboard.press('Home')
    await p.keyboard.type('// TODO: rate-limit failed attempts per IP\n', { delay: 35 })
    await p.waitForTimeout(700)
    await p.locator('.vtab-action[title^="Save"]').click()      // 💾
    await p.waitForTimeout(1500)
    await ctx.close()
  }

  // ── Clip 2: memo → agent ──
  {
    const { ctx, p } = await newPage(browser)
    await p.locator('.wb-files-btn').click()
    await p.waitForTimeout(1200)
    await p.locator('.tree-row.tree-dir', { hasText: 'src' }).first().click()
    await p.waitForTimeout(800)
    await p.locator('.tree-row.tree-file', { hasText: 'auth.ts' }).first().click()
    await p.waitForTimeout(2000)
    // select the word "unauthorized" and open the context menu on it
    const word = p.locator('.cm-content >> text=unauthorized()').first()
    await word.dblclick()
    await p.waitForTimeout(700)
    await word.click({ button: 'right' })
    await p.waitForTimeout(900)
    await p.locator('.ctx-menu-item', { hasText: 'Add Note' }).click()
    await p.waitForTimeout(700)
    await p.locator('.memo-textarea').fill('')
    await p.keyboard.type('401 응답에도 rate limit 카운트를 올려줘 — 브루트포스 방어', { delay: 25 })
    await p.waitForTimeout(500)
    await p.locator('.memo-panel-actions .btn-primary').click() // save memo
    await p.waitForTimeout(1300)
    await p.locator('.vtab-action[title="Send notes to agent"]').click()  // ▶ 1
    await p.waitForTimeout(3500)                                // lands in the terminal
    await ctx.close()
  }

  await browser.close()
  console.log('viewer clips recorded')
})()
