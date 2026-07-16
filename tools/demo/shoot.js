// README screenshot shoot against the isolated demo instance on :13002.
const { chromium } = require('playwright-core')
const crypto = require('crypto')

const OUT = __dirname
const TOKEN = crypto.createHmac('sha256', 'termhub').update('demo-shots-1').digest('hex')

async function prep(context) {
  await context.addCookies([{ name: 'token', value: TOKEN, url: 'http://127.0.0.1:13002' }])
}

;(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })

  // ── Mobile: waiting session with the quick-approve bar ──
  const mob = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  })
  await prep(mob)
  const mp = await mob.newPage()
  await mp.goto('http://127.0.0.1:13002/', { waitUntil: 'networkidle' })
  await mp.waitForTimeout(2500)
  // open the api-server folder (waiting session) via the sidebar
  await mp.evaluate(() => document.querySelector("button[title^=\"Toggle sidebar\"]")?.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  await mp.waitForTimeout(600)
  const folder = mp.locator('.folder-item', { hasText: 'api-server' })
  if (await folder.count()) { await folder.first().click(); await mp.waitForTimeout(2500) }
  await mp.screenshot({ path: `${OUT}/shot-mobile-waiting.png` })

  // mobile folder list with state chips
  await mp.evaluate(() => document.querySelector("button[title^=\"Toggle sidebar\"]")?.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  await mp.waitForTimeout(700)
  await mp.screenshot({ path: `${OUT}/shot-mobile-folders.png` })
  await mob.close()

  // ── Desktop: grid view showing all three states at once ──
  const desk = await browser.newContext({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 2 })
  await prep(desk)
  const dp = await desk.newPage()
  await dp.addInitScript(() => localStorage.setItem('agentboard.viewMode', 'grid'))
  await dp.goto('http://127.0.0.1:13002/', { waitUntil: 'networkidle' })
  await dp.waitForTimeout(2000)
  const fweb = dp.locator('.folder-item', { hasText: 'web-dashboard' })
  if (await fweb.count()) { await fweb.first().click(); await dp.waitForTimeout(3000) }
  await dp.screenshot({ path: `${OUT}/shot-desktop-grid.png` })

  // Desktop single view on the working session
  await dp.evaluate(() => localStorage.setItem('agentboard.viewMode', 'single'))
  const f2 = dp.locator('.folder-item', { hasText: 'api-server' })
  if (await f2.count()) { await f2.first().click(); await dp.waitForTimeout(2500) }
  await dp.screenshot({ path: `${OUT}/shot-desktop-single.png` })
  await desk.close()

  await browser.close()
  console.log('shots written')
})()
