// Record the approve→continue loop as video (webm) for README GIFs.
const { chromium } = require('playwright-core')
const crypto = require('crypto')
const TOKEN = crypto.createHmac('sha256', 'termhub').update('demo-shots-1').digest('hex')
const OUT = __dirname + '/video'

;(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })

  // ── Desktop: grid → click the Asking tile → approve with the ⏎ quick key ──
  const desk = await browser.newContext({
    viewport: { width: 1440, height: 860 },
    recordVideo: { dir: OUT, size: { width: 1440, height: 860 } },
  })
  await desk.addCookies([{ name: 'token', value: TOKEN, url: 'http://127.0.0.1:13002' }])
  const dp = await desk.newPage()
  await dp.addInitScript(() => localStorage.setItem('agentboard.viewMode', 'grid'))
  await dp.goto('http://127.0.0.1:13002/', { waitUntil: 'networkidle' })
  await dp.waitForTimeout(1200)
  await dp.locator('.folder-item', { hasText: 'web-dashboard' }).first().click()
  await dp.waitForTimeout(3500)                       // grid with spinner motion
  await dp.locator('.grid-tile', { hasText: 'add API rate limiting' }).first().click()
  await dp.waitForTimeout(1500)
  await dp.locator('.quick-key', { hasText: '⏎' }).first().click()   // approve
  await dp.waitForTimeout(7500)                       // agent continues → done
  await desk.close()

  // ── Mobile: folders → waiting session → tap Yes on the quick-approve bar ──
  const mob = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    recordVideo: { dir: OUT, size: { width: 390, height: 844 } },
  })
  await mob.addCookies([{ name: 'token', value: TOKEN, url: 'http://127.0.0.1:13002' }])
  const mp = await mob.newPage()
  await mp.goto('http://127.0.0.1:13002/', { waitUntil: 'networkidle' })
  await mp.waitForTimeout(1500)
  await mp.evaluate(() => document.querySelector('button[title^="Toggle sidebar"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await mp.waitForTimeout(1200)                       // folder list with chips
  await mp.locator('.folder-item', { hasText: 'api-server' }).first().click()
  await mp.waitForTimeout(2500)                       // waiting session + approve bar
  await mp.locator('.qa-btn', { hasText: 'Yes' }).first().click()
  await mp.waitForTimeout(7500)                       // agent continues → done
  await mob.close()

  await browser.close()
  console.log('videos recorded')
})()
