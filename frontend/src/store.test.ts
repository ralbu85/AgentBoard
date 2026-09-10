import { beforeEach, describe, expect, it } from 'vitest'
import { useStore, viewerKey, type ViewerTab } from './store'

const tab: ViewerTab = { id: '/project/a.py', path: '/project/a.py', name: 'a.py', type: 'code', lang: 'python', content: 'original', version: 'v1' }
beforeEach(() => {
  localStorage.clear()
  useStore.setState({ sessions: {}, activeId: null, workspaceCwd: '/project', workspaceHost: 'local', _viewerState: {}, _completedAt: {} })
})
describe('workspace files', () => {
  it('opens and edits without an agent session', () => {
    useStore.getState().openTab(tab)
    useStore.getState().updateTab(tab.id, 'edited')
    expect(useStore.getState()._viewerState[viewerKey(useStore.getState())].tabs[0]).toMatchObject({ content: 'edited', dirty: true })
  })
  it('shares tabs between sessions but isolates machines and folders', () => {
    const s = useStore.getState()
    s.upsertSession({ id: '1', cwd: '/project', cmd: 'bash' })
    s.upsertSession({ id: '2', cwd: '/project', cmd: 'codex' })
    s.upsertSession({ id: 'remote:1', cwd: '/project', cmd: 'bash', host: 'remote' })
    s.setActive('1'); s.openTab(tab)
    const localKey = viewerKey(useStore.getState())
    s.setActive('2')
    expect(viewerKey(useStore.getState())).toBe(localKey)
    s.setActive('remote:1')
    expect(viewerKey(useStore.getState())).not.toBe(localKey)
    s.setWorkspace('/another')
    expect(useStore.getState()._viewerState[viewerKey(useStore.getState())]).toBeUndefined()
  })
  it('finishes an asynchronous save in its original workspace and preserves later edits', () => {
    const s = useStore.getState()
    s.openTab(tab); s.updateTab(tab.id, 'sent to server')
    const key = viewerKey(useStore.getState())
    s.updateTab(tab.id, 'newer typing')
    s.setWorkspace('/other'); s.openTab(tab)
    s.markTabSaved(tab.id, 'sent to server', 'v2', key)
    expect(useStore.getState()._viewerState[key].tabs[0]).toMatchObject({ content: 'newer typing', dirty: true, version: 'v2' })
    expect(useStore.getState()._viewerState[viewerKey(useStore.getState())].tabs[0].version).toBe('v1')
  })
  it('does not resurrect legacy session tabs after the last workspace tab is closed', async () => {
    const s = useStore.getState()
    s.upsertSession({ id: '1', cwd: '/project', cmd: 'bash' })
    localStorage.setItem('agentboard.viewer.1', JSON.stringify({ tabs: [tab] }))
    s.openTab(tab)
    s.closeTab(tab.id)
    const key = viewerKey(useStore.getState())
    useStore.setState({ _viewerState: {} })
    await s.restoreViewerTabs(key)
    expect(useStore.getState()._viewerState[key]).toBeUndefined()
  })
  it('does not flash completed over a new working state', () => {
    const s = useStore.getState()
    s.upsertSession({ id: '1', cwd: '/project', cmd: 'codex' })
    s.handleMessage({ type: 'aiState', id: '1', state: 'working' })
    s.handleMessage({ type: 'aiState', id: '1', state: 'idle' })
    s.handleMessage({ type: 'aiState', id: '1', state: 'working' })
    expect(s.effectiveState('1')).toBe('working')
  })
})
