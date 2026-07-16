import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Unit tests run the REAL TerminalManager against @xterm/headless (same core,
// no renderer) — the buffer/scroll state machine is fully exercised without a
// browser. DOM-only addons are stubbed.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@xterm/xterm': '@xterm/headless',
      '@xterm/addon-search': fileURLToPath(new URL('./src/test/xterm-addon-stub.ts', import.meta.url)),
      '@xterm/addon-web-links': fileURLToPath(new URL('./src/test/xterm-addon-stub.ts', import.meta.url)),
    },
  },
})
