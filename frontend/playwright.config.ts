import {defineConfig,devices} from '@playwright/test'

// UI verification follows the same policy as production browsers. Do not add
// a no-sandbox fallback when this environment cannot launch Chromium safely.
if(process.getuid?.()===0)throw Error('Browser tests require a non-root, sandbox-capable machine. No browser was launched.')

export default defineConfig({
  testDir:'./e2e',
  timeout:30_000,
  use:{baseURL:'http://127.0.0.1:4179',launchOptions:{chromiumSandbox:true},trace:'retain-on-failure'},
  projects:[
    {name:'desktop',use:{...devices['Desktop Chrome']}},
    {name:'phone',use:{...devices['iPhone 13'],defaultBrowserType:'chromium'}},
  ],
  webServer:{command:'npx vite --host 127.0.0.1 --port 4179 --strictPort',url:'http://127.0.0.1:4179/e2e/terminal-fixture.html',reuseExistingServer:false},
})
