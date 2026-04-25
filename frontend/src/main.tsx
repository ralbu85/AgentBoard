import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'
import 'katex/dist/katex.min.css'

// --vvh tracks the visual viewport height (keyboard-aware on iOS where dvh
// doesn't shrink). Single source of truth for app height.
const vv = window.visualViewport
const setVVH = () => {
  const h = vv?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--vvh', `${h}px`)
}
setVVH()
vv?.addEventListener('resize', setVVH)
window.addEventListener('orientationchange', setVVH)

createRoot(document.getElementById('root')!).render(<App />)
