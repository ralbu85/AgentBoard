import { beforeEach, expect, it, vi } from 'vitest'
import { api } from './api'
import { useStore } from './store'
import { spawnAndFocus, CLEAN_TERMINAL } from './spawn'
vi.mock('./api', () => ({ api: { spawn: vi.fn(), workers: vi.fn() } }))
vi.mock('./ws', () => ({ notifyActive: vi.fn(), send: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useStore.setState({ sessions: {}, activeId: null, _spawnReqs: {}, _viewerState: {}, _restoredWorkspaces: {}, _sessionViewReady:false, workspaceCwd:'~',workspaceHost:'local',hiddenSessions:[],unreadCompletions:[] })
})
it('opens a clean local shell and uses canonical server cwd without a WS event', async () => {
  vi.mocked(api.spawn).mockResolvedValue({ok:true,id:'10'})
  vi.mocked(api.workers).mockResolvedValue([{id:'10',sessionName:'term-10',cwd:'/home/test',cmd:CLEAN_TERMINAL, status:'running',createdAt:123}])
  expect(await spawnAndFocus('~')).toBe(true)
  expect(api.spawn).toHaveBeenCalledWith('~',CLEAN_TERMINAL,'local',expect.any(String))
  expect(useStore.getState()).toMatchObject({activeId:'10',workspaceCwd:'/home/test',workspaceHost:'local'})
  expect(useStore.getState().sessions['10']).toMatchObject({sessionName:'term-10',createdAt:123})
})
it('coalesces repeated clicks while a creation request is pending', async () => {
  let resolve!: (value: any) => void
  vi.mocked(api.spawn).mockImplementation(() => new Promise(r => { resolve = r }))
  const first=spawnAndFocus('/project')
  const second=spawnAndFocus('/project')
  expect(first).toBe(second)
  resolve({ok:false})
  expect(await first).toBe(false)
  expect(api.spawn).toHaveBeenCalledTimes(1)
})
it('preserves workspace and selection on failed creation', async () => {
  vi.mocked(api.spawn).mockResolvedValue({ok:false,error:'unavailable'})
  expect(await spawnAndFocus('/wrong')).toBe(false)
  expect(useStore.getState()).toMatchObject({activeId:null,workspaceCwd:'~'})
})
it('selects the correct remote host when its correlated event already arrived', async () => {
  vi.mocked(api.spawn).mockImplementation(async (_cwd,_cmd,_host,reqId) => {
    useStore.setState({sessions:{'remote:7':{id:'remote:7',cwd:'/remote/project',host:'remote',cmd:'bash'} as any},_spawnReqs:{[reqId!]:'remote:7'}})
    return {ok:true}
  })
  expect(await spawnAndFocus('/remote/project','remote')).toBe(true)
  expect(useStore.getState()).toMatchObject({activeId:'remote:7',workspaceHost:'remote',workspaceCwd:'/remote/project'})
  expect(api.workers).not.toHaveBeenCalled()
})

it('releases the creation dialog when the server never answers, without retrying', async () => {
  vi.useFakeTimers()
  try {
    vi.mocked(api.spawn).mockImplementation(() => new Promise(() => {}))
    const result=spawnAndFocus('/unresponsive')
    await vi.advanceTimersByTimeAsync(30000)
    expect(await result).toBe(false)
    expect(api.spawn).toHaveBeenCalledTimes(1)
    expect(useStore.getState().activeId).toBeNull()
  } finally { vi.useRealTimers() }
})
