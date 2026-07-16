// Record a REAL Claude Code session through AgentBoard, phone + desktop
// simultaneously. Phone approves the trust dialog; desktop sends the task and
// approves the edit; both record until Claude finishes (or timeout).
const { chromium } = require('playwright-core')
const crypto = require('crypto')
const TOKEN = crypto.createHmac('sha256', 'termhub').update('demo-shots-1').digest('hex')
const OUT = __dirname + '/video4'

async function state() {
  const r = await fetch('http://127.0.0.1:13002/api/workers', { headers: { Cookie: `token=${TOKEN}` } })
  const w = (await r.json()).find(w => w.id === '1')
  return w ? (w.aiState || w.status) : 'gone'
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitState(want, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const s = await state()
    if (want.includes(s)) return s
    await sleep(1000)
  }
  return 'timeout:' + await state()
}

;(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })

  const desk = await browser.newContext({ viewport: { width: 1440, height: 860 }, recordVideo: { dir: OUT, size: { width: 1440, height: 860 } } })
  await desk.addCookies([{ name: 'token', value: TOKEN, url: 'http://127.0.0.1:13002' }])
  const dp = await desk.newPage()
  await dp.addInitScript(() => localStorage.setItem('agentboard.viewMode', 'single'))

  const mob = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    recordVideo: { dir: OUT, size: { width: 390, height: 844 } },
  })
  await mob.addCookies([{ name: 'token', value: TOKEN, url: 'http://127.0.0.1:13002' }])
  const mp = await mob.newPage()

  await dp.goto('http://127.0.0.1:13002/', { waitUntil: 'networkidle' })
  await mp.goto('http://127.0.0.1:13002/', { waitUntil: 'networkidle' })
  await sleep(3000)

  // 1. PHONE approves the trust dialog via the quick-approve bar
  console.log('state before trust:', await state())
  await mp.locator('.qa-btn', { hasText: 'Yes' }).first().click()
  console.log('trust approved from phone')
  await sleep(5000)

  // 2. DESKTOP sends the real task
  await dp.locator('.input-textarea').click()
  await dp.keyboard.type('Add per-IP rate limiting to src/server.py with slowapi (60/min default, 10/min on /api/search), then tick the matching README checklist item.', { delay: 12 })
  await sleep(600)
  await dp.locator('.send-btn').click()
  console.log('task sent')

  // 3. Claude works — wait for its first permission ask (or straight to idle)
  let s = await waitState(['waiting'], 150000)
  console.log('reached:', s)
  if (s === 'waiting') {
    await sleep(2500)
    await dp.locator('.qa-btn', { hasText: 'Yes' }).first().click()
    console.log('edit approved from desktop')
    // keep approving whatever else it asks, up to 4 times
    for (let i = 0; i < 4; i++) {
      s = await waitState(['waiting', 'idle', 'completed'], 120000)
      console.log('next state:', s)
      if (s !== 'waiting') break
      await sleep(2000)
      await dp.locator('.qa-btn', { hasText: 'Yes' }).first().click()
      console.log('approved again')
    }
  }
  await waitState(['idle', 'completed'], 120000)
  console.log('final state:', await state())
  await sleep(6000)

  await desk.close(); await mob.close(); await browser.close()
  console.log('real-session videos recorded')
})()
