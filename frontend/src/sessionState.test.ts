import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {api} from './api'
import {useStore, completionKey, workspaceId} from './store'
import type {Session, SessionStateSnapshot} from './types'

const session: Session = {id:'1', sessionName:'term-1', host:'local', cwd:'/project', cmd:'codex',
  status:'running', aiState:'idle', createdAt:123, memKB:0, process:'codex', completionEvent:'event-a', completionUnread:true}
const snapshot = (revision:number, sessions:Session[] = [session]):SessionStateSnapshot => ({type:'session-state', revision, sessions})
beforeEach(()=>{
  localStorage.clear()
  useStore.setState({_sessionStateRevision:-1, _sessionViewReady:false, sessions:{}, unreadCompletions:[], _spawnReqs:{}, _pendingSpawnReqs:{},
    _viewerState:{}, hiddenSessions:[], activeId:null, workspaceCwd:'/project', workspaceHost:'local'})
})
afterEach(()=>vi.restoreAllMocks())

it('uses the server snapshot even on a first visit with contradictory local records',()=>{
  localStorage.setItem('agentboard.unreadCompletions', JSON.stringify(['obsolete']))
  localStorage.setItem('agentboard.completionEvents.["local","term-1"]', JSON.stringify(['event-a']))
  useStore.getState().handleMessage(snapshot(1))
  expect(useStore.getState().unreadCompletions).toEqual([completionKey(session)])
  useStore.getState().handleMessage(snapshot(2,[{...session,completionUnread:false}]))
  expect(useStore.getState().unreadCompletions).toEqual([])
})

it('acknowledges the displayed event on the server without changing the live work state',async()=>{
  const working = {...session, aiState:'working'}
  useStore.getState().handleMessage(snapshot(1,[working]))
  const request = vi.spyOn(api,'acknowledgeCompletion').mockResolvedValue(snapshot(2,[{...working,completionUnread:false}]))
  useStore.getState().setActive('1') // navigation alone does not acknowledge
  expect(useStore.getState().unreadCompletions).toHaveLength(1)
  await useStore.getState().acknowledgeCompletion('1')
  expect(request).toHaveBeenCalledWith('1','event-a')
  expect(useStore.getState().unreadCompletions).toEqual([])
  expect(useStore.getState().sessions['1'].aiState).toBe('working')
})

it('receives another device’s acknowledgement without replacing the selected file, draft or workspace',()=>{
  const s=useStore.getState()
  s.handleMessage(snapshot(1))
  s.setWorkspace('/other')
  s.openTab({id:'draft',path:'/other/a.md',name:'a.md',type:'markdown',lang:'',content:'unsaved',dirty:true})
  s.handleMessage(snapshot(2,[{...session,completionUnread:false}]))
  expect(useStore.getState().unreadCompletions).toEqual([])
  expect(useStore.getState().workspaceCwd).toBe('/other')
  expect(useStore.getState()._viewerState[workspaceId('/other')].tabs[0]).toMatchObject({content:'unsaved',dirty:true})
})

it('does not let a delayed HTTP receipt clear a newer result delivered by websocket',async()=>{
  const s=useStore.getState()
  s.handleMessage(snapshot(1))
  let finish!:(value:unknown)=>void
  vi.spyOn(api,'acknowledgeCompletion').mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const request=s.acknowledgeCompletion('1')
  s.handleMessage(snapshot(3,[{...session,completionEvent:'event-b',aiState:'waiting'}]))
  finish(snapshot(2,[{...session,completionUnread:false}]))
  await request
  expect(useStore.getState().unreadCompletions).toHaveLength(1)
  expect(useStore.getState().sessions['1']).toMatchObject({completionEvent:'event-b',aiState:'waiting'})
})

it('keeps an unread result on a failed acknowledgement and retries the same event',async()=>{
  const s=useStore.getState()
  s.handleMessage(snapshot(1))
  const request=vi.spyOn(api,'acknowledgeCompletion').mockResolvedValueOnce({ok:false})
    .mockResolvedValueOnce(snapshot(2,[{...session,completionUnread:false}]))
  await s.acknowledgeCompletion('1')
  expect(useStore.getState().unreadCompletions).toHaveLength(1)
  await s.acknowledgeCompletion('1')
  expect(request).toHaveBeenNthCalledWith(2,'1','event-a')
  expect(useStore.getState().unreadCompletions).toEqual([])
})

it('rejects older snapshots and legacy state replays after synchronization',()=>{
  const s=useStore.getState()
  s.handleMessage(snapshot(10,[{...session,completionUnread:false}]))
  s.handleMessage(snapshot(9))
  s.handleMessage({type:'aiState',id:'1',state:'working',completionId:'old'})
  s.handleMessage({type:'status',id:'1',status:'completed'})
  s.handleMessage({type:'sessions',sessions:[]})
  s.handleMessage({type:'spawned',id:'1',sessionName:'old',cwd:'/old',cmd:'bash',status:'running',reqId:'new-spawn'})
  expect(useStore.getState().sessions['1']).toMatchObject({aiState:'idle',status:'running',sessionName:'term-1'})
  expect(useStore.getState().unreadCompletions).toEqual([])
  expect(useStore.getState()._spawnReqs['new-spawn']).toBe('1')
})

it('reconciles remote disconnect and removal from the same authoritative inventory',()=>{
  const remote={...session,id:'office:1',host:'office'}
  const s=useStore.getState()
  s.handleMessage(snapshot(1,[session,remote]))
  s.handleMessage(snapshot(2,[session,{...remote,online:false}]))
  expect(useStore.getState().sessions['office:1'].online).toBe(false)
  s.handleMessage(snapshot(3,[session]))
  expect(useStore.getState().sessions['office:1']).toBeUndefined()
  expect(useStore.getState().unreadCompletions).toEqual([completionKey(session)])
})

it('does not synthesize a completion from working/idle redraws before a server snapshot',()=>{
  const s=useStore.getState()
  s.upsertSession({id:'1',cwd:'/project',cmd:'codex'})
  s.handleMessage({type:'aiState',id:'1',state:'working'})
  s.handleMessage({type:'aiState',id:'1',state:'idle',completionId:'turn-a'})
  expect(useStore.getState().unreadCompletions).toEqual([])
})

it('resolves a new spawn only when its session can actually be selected',()=>{
  const s=useStore.getState()
  s.handleMessage(snapshot(1,[]))
  s.handleMessage({type:'spawned',id:'1',sessionName:'term-1',cwd:'/project',cmd:'bash',status:'running',reqId:'request'})
  expect(useStore.getState()._spawnReqs['request']).toBeUndefined()
  s.handleMessage(snapshot(2))
  expect(useStore.getState()._spawnReqs['request']).toBe('1')
  expect(useStore.getState().sessions['1']).toMatchObject(session)
  expect(useStore.getState()._pendingSpawnReqs).toEqual({})
})
