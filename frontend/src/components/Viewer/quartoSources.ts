import {useEffect, useMemo, useState} from 'react'
import {quietJson} from './docSync'
import {frozenCells, includedPaths, type FrozenRun, type QuartoSources} from './markdownBlocks'

const WATCH_EVERY = 2000
const NESTING = 4

/** The files a Quarto document draws from: what it includes (nested, read-only)
 *  and the outputs its last run saved. Both follow the disk, so a re-render or
 *  an agent's edit to an included file shows without reopening the tab. */
export function useQuartoSources(src: string, filePath: string | undefined, enabled: boolean): QuartoSources {
  const [includes, setIncludes] = useState<Record<string, string>>({})
  const [frozen, setFrozen] = useState<FrozenRun | null>(null)
  const [watched, setWatched] = useState<string[]>([])
  const [changes, setChanges] = useState(0)
  const wanted = useMemo(() => enabled && filePath ? includedPaths(src, filePath).join('\n') : '', [src, filePath, enabled])

  useEffect(() => {
    if (!enabled || !filePath) { setIncludes({}); setFrozen(null); setWatched([]); return }
    let alive = true
    void (async () => {
      const found: Record<string, string> = {}
      let level = wanted ? wanted.split('\n') : []
      for (let depth = 0; depth < NESTING && level.length; depth++) {
        const read = await Promise.all(level.map(path => quietJson(`/api/file?path=${encodeURIComponent(path)}`).catch(() => null)))
        const next: string[] = []
        level.forEach((path, k) => {
          const content = read[k]?.content
          if (typeof content !== 'string') return
          found[path] = content
          for (const inner of includedPaths(content, path)) if (!(inner in found)) next.push(inner)
        })
        level = [...new Set(next)]
      }
      const run = /\.qmd$/i.test(filePath) ? await quietJson(`/api/quarto-freeze?path=${encodeURIComponent(filePath)}`).catch(() => null) : null
      if (!alive) return
      setIncludes(found)
      const stem = filePath.slice(filePath.lastIndexOf('/') + 1).replace(/\.qmd$/i, '')
      setFrozen(typeof run?.markdown === 'string' && typeof run.folder === 'string' ? {cells: frozenCells(run.markdown), folder: run.folder, stem} : null)
      setWatched([...Object.keys(found), ...(typeof run?.results === 'string' ? [run.results] : [])])
    })()
    return () => { alive = false }
  }, [wanted, filePath, enabled, changes])

  // Reload when any of them changes on disk.
  useEffect(() => {
    if (!watched.length) return
    let alive = true, busy = false
    const seen = new Map<string, string>()
    const check = async () => {
      if (busy || document.visibilityState === 'hidden') return
      busy = true
      try {
        const stats = await Promise.all(watched.map(path => quietJson(`/api/file-stat?path=${encodeURIComponent(path)}`).catch(() => null)))
        if (!alive) return
        let changed = false
        watched.forEach((path, k) => {
          const signature = stats[k]?.signature
          if (typeof signature !== 'string') return
          if (seen.has(path) && seen.get(path) !== signature) changed = true
          seen.set(path, signature)
        })
        if (changed) setChanges(n => n + 1)
      } finally { busy = false }
    }
    void check()
    const timer = window.setInterval(check, WATCH_EVERY)
    return () => { alive = false; window.clearInterval(timer) }
  }, [watched])

  return useMemo(() => ({includes, frozen}), [includes, frozen])
}
