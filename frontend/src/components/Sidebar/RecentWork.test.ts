import {act,createElement} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {RecentWork} from './RecentWork'
import {useStore,completionKey,workspaceId} from '../../store'
import type {Session,RecentWork as Work,SessionStateSnapshot} from '../../types'
import {api} from '../../api'

let host:HTMLDivElement,root:Root
const session:Session={id:'1',host:'local',cwd:'/project',sessionName:'pane',createdAt:10,cmd:'codex',status:'running',aiState:'idle',memKB:0,process:'codex',completionEvent:'done',completionUnread:true}
const work=(index:number):Work=>({id:`work-${index}`,sessionId:'1',host:'local',cwd:'/project',sessionName:'pane',createdAt:10,title:`작업 ${index}`,command:'codex',at:100-index,status:'completed',event:'done',unread:true})
function snapshot(revision=1,historyRevision=1):SessionStateSnapshot{
  return {type:'session-state',revision,sessions:[session],recentWork:{revision:historyRevision,items:Array.from({length:6},(_,i)=>work(i))}}
}
beforeEach(()=>{
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  localStorage.clear()
  useStore.setState({_sessionStateRevision:-1,_recentWorkRevision:-1,recentWork:[],recentWorkError:'',sessions:{},titles:{},activeId:null,workspaceCwd:'/elsewhere',workspaceHost:'local',workspaceFolders:[],workspaceOrder:['keep-this-order'],hiddenWorkspaces:[],hiddenSessions:[],_sessionViewReady:false,_viewerState:{},_restoredWorkspaces:{},connection:'online'})
  useStore.getState().applySessionState(snapshot())
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
  act(()=>root.render(createElement(RecentWork)))
})
afterEach(()=>{act(()=>root.unmount());host.remove();vi.restoreAllMocks()})

it('shows five requests and retains the entry after opening and acknowledging its result',async()=>{
  expect(host.querySelectorAll('.recent-work-item')).toHaveLength(5)
  vi.spyOn(api,'acknowledgeCompletion').mockImplementation(async()=>{
    const next=snapshot(2,2);next.sessions=[{...session,completionUnread:false}]
    next.recentWork!.items=next.recentWork!.items.map(item=>({...item,unread:false}))
    return next
  })
  await act(async()=>host.querySelector<HTMLButtonElement>('.recent-work-open')!.click())
  expect(useStore.getState().activeId).toBe('1')
  expect(useStore.getState().workspaceCwd).toBe('/project')
  expect(useStore.getState().workspaceOrder).toEqual(['keep-this-order'])
  expect(host.querySelectorAll('.recent-work-item')).toHaveLength(5)
  expect(host.querySelector('[data-unread=true]')).toBeNull()
  expect(host.textContent).toContain('작업 0')
})

it('opens the workspace without resurrecting a dismissed terminal tab',async()=>{
  const key=workspaceId('/project')
  const file={id:'file',name:'result.md',path:'/project/result.md',content:'',type:'markdown' as const,lang:''}
  act(()=>useStore.setState({hiddenSessions:[completionKey(session)],hiddenWorkspaces:[key],_viewerState:{[key]:{tabs:[file],activeTabId:'file'}}}))
  vi.spyOn(api,'acknowledgeCompletion').mockResolvedValue({ok:false})
  await act(async()=>host.querySelector<HTMLButtonElement>('.recent-work-open')!.click())
  expect(useStore.getState().activeId).toBeNull()
  expect(useStore.getState().workspaceCwd).toBe('/project')
  expect(useStore.getState().hiddenSessions).toEqual([completionKey(session)])
  expect(useStore.getState()._viewerState[key].tabs).toEqual([file])
  expect(host.textContent).toContain('완료 · 탭 닫힘')
})

it('does not jump to an unrelated session that reused the same numeric id',async()=>{
  act(()=>useStore.setState({sessions:{'1':{...session,createdAt:99,cwd:'/other'}}}))
  await act(async()=>host.querySelector<HTMLButtonElement>('.recent-work-open')!.click())
  expect(useStore.getState().activeId).toBeNull()
  expect(useStore.getState().workspaceCwd).toBe('/project')
  expect(host.textContent).toContain('완료 · 종료')
})

it('applies shared title changes independently of status revision and rejects stale history',()=>{
  const newer=snapshot(1,3);newer.recentWork!.items[0].title='다른 기기에서 수정'
  act(()=>useStore.getState().applySessionState(newer))
  expect(host.textContent).toContain('다른 기기에서 수정')
  act(()=>useStore.getState().applySessionState(snapshot(2,2)))
  expect(host.textContent).toContain('다른 기기에서 수정')
  act(()=>useStore.getState().applySessionState({...snapshot(3,3),recentWork:undefined,recentWorkError:'기록 저장 실패'}))
  expect(host.textContent).toContain('기록 저장 실패')
  act(()=>useStore.getState().applySessionState({...newer,revision:3}))
  expect(host.textContent).not.toContain('기록 저장 실패')
})

it('edits a work title and shares the returned revision without changing recency',async()=>{
  const update=vi.spyOn(api,'renameRecentWork').mockImplementation(async(id,title)=>{
    const next=snapshot(1,2);next.recentWork!.items[0]={...work(0),id,title};return next
  })
  await act(async()=>host.querySelector<HTMLButtonElement>('.recent-work-rename')!.click())
  const input=host.querySelector('input')!
  act(()=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'기억할 작업명')
    input.dispatchEvent(new Event('input',{bubbles:true}))
  })
  await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  expect(update).toHaveBeenCalledExactlyOnceWith('work-0','기억할 작업명')
  expect(host.textContent).toContain('기억할 작업명')
  expect(useStore.getState().recentWork[0].at).toBe(100)
})

it('can collapse the five rows without discarding the shared history',async()=>{
  await act(async()=>host.querySelector<HTMLButtonElement>('.recent-work-heading')!.click())
  expect(host.querySelectorAll('.recent-work-item')).toHaveLength(0)
  expect(useStore.getState().recentWork).toHaveLength(5)
  await act(async()=>host.querySelector<HTMLButtonElement>('.recent-work-heading')!.click())
  expect(host.querySelectorAll('.recent-work-item')).toHaveLength(5)
})
