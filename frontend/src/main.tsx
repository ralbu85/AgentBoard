import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'
import 'katex/dist/katex.min.css'

// --vvh tracks the visual viewport height (keyboard-aware on iOS where dvh
// doesn't shrink). Single source of truth for app height.
//
// Applied with care — resizing --vvh reflows the ENTIRE app:
// - Settle-once: the keyboard slide fires a burst of resize events; applying
//   each one reflows the app per frame, which reads as the page behind the
//   keyboard flashing in and out. Debounce until the viewport settles.
// - While typing, the Korean IME suggestion bar toggles the viewport by
//   ~50px on nearly every keystroke — ignore small wobbles while an input
//   is focused (the bar briefly overlaps the quick-key row instead; fine).
//   Real keyboard open/close moves hundreds of px and always applies.
const vv = window.visualViewport
let _vvhTimer: number | undefined
let _lastVVH = 0
const setVVH = () => {
  const h = Math.round(vv?.height ?? window.innerHeight)
  if (h === _lastVVH) return
  const ae = document.activeElement
  const typing = !!ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')
  if (typing && _lastVVH && Math.abs(h - _lastVVH) < 100) return
  _lastVVH = h
  document.documentElement.style.setProperty('--vvh', `${h}px`)
}
const queueVVH = () => {
  window.clearTimeout(_vvhTimer)
  _vvhTimer = window.setTimeout(setVVH, 120)
}
setVVH()
vv?.addEventListener('resize', queueVVH)
window.addEventListener('orientationchange', queueVVH)
// Keyboard dismissed / focus left the input — re-sync even if the last small
// wobble was skipped by the typing guard above.
window.addEventListener('focusout', queueVVH)

// Register the push service worker (best-effort; secure context only).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(<App />)
