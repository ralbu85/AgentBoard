import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {api} from '../../api'
import { FolderList } from './FolderList'
import { useStore, completionKey, workspaceId } from '../../store'
import type { Session } from '../../types'

let root:Root, host:HTMLDivElement
let revision=0
function serverState(unread: string[], changes:Record<string,Partial<Session>> = {}) {
  const sessions=Object.values(useStore.getState().sessions).map(s=>({...s,...changes[s.id],completionEvent:changes[s.id]?.completionEvent||s.completionEvent||'event-'+s.id,completionUnread:unread.includes(s.id)}))
  return {type:'session-state' as const,revision:++revision,sessions}
}
function markUnread(ids:string[]) {useStore.getState().applySessionState(serverState(ids))}

const session=(id:string,aiState:string|null,cwd='/project'):Session=>({id,aiState,cwd,host:'local',sessionName:'term-'+id,cmd:'codex',status:'running',process:'codex',createdAt:1,memKB:0,autoTitle:'Session '+id})
beforeEach(()=>{
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  localStorage.clear()
  revision=0
  vi.spyOn(api,'acknowledgeCompletion').mockImplementation(async(id)=>serverState(Object.values(useStore.getState().sessions).filter(s=>s.completionUnread&&s.id!==id).map(s=>s.id)))
  const work=session('1','working'),idle=session('2','idle'),waiting=session('3','waiting','/second')
  useStore.setState({_sessionStateRevision:-1,workspaceActivity:{},workspaceOrderBaseline:{},activityError:'',connection:'online',sessions:{'1':work,'2':idle,'3':waiting},titles:{},activeId:null,workspaceCwd:'/project',workspaceHost:'local',workspaceFolders:[],workspaceOrder:[],hiddenWorkspaces:[],hiddenSessions:[],unreadCompletions:[completionKey(work)],_sessionViewReady:false,_viewerState:{},_restoredWorkspaces:{}})
  markUnread(['1'])
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
  act(()=>root.render(createElement(FolderList)))
})
afterEach(()=>{act(()=>root.unmount());host.remove();vi.restoreAllMocks()})
it('shows the task summary inline and reorders existing workspaces without a separate history panel',()=>{
  const update=serverState([],{'3':{taskTitle:'노트북 셀 편집 개선'}})
  act(()=>useStore.getState().applySessionState({...update,workspaceActivity:{[workspaceId('/second')]:100}}))
  expect(host.querySelector('.workspace-picker-name')?.textContent).toBe('second')
  expect(host.querySelector('.workspace-session-name')?.textContent).toBe('노트북 셀 편집 개선')
  expect(host.querySelector('.recent-work')).toBeNull()
  expect(host.textContent).toContain('최근 작업순')
})
it('shows working independently of unread news and acknowledges news on selection',async()=>{
  const row=host.querySelector<HTMLButtonElement>('[data-state=working]')!
  expect(row.querySelector('.workspace-session-status > span:last-child')?.textContent).toBe('작업 중')
  expect(row.querySelector('.workspace-unread-dot')).not.toBeNull()
  await act(async()=>row.click())
  expect(host.querySelector('[data-state=working] .workspace-session-status > span:last-child')?.textContent).toBe('작업 중')
  expect(host.querySelector('.workspace-unread-dot')).toBeNull()
})

it('keeps selection separate from working and completed, and clears only the unread marker on review',async()=>{
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-state=working]')!.click())
  let selected=host.querySelector<HTMLButtonElement>('.workspace-session.selected')!
  expect(selected.getAttribute('aria-current')).toBe('true')
  expect(selected.querySelector('.workspace-selection-mark')?.textContent).toBe('›')
  expect(selected.querySelector('.session-status-badge')?.getAttribute('data-status')).toBe('working')
  act(()=>useStore.getState().applySessionState(serverState(['1'],{'1':{aiState:'idle',completionEvent:'fresh-result'}})))
  selected=host.querySelector<HTMLButtonElement>('.workspace-session.selected')!
  expect(selected.querySelector('.session-status-badge')?.getAttribute('data-status')).toBe('completed')
  expect(selected.querySelector('.workspace-unread-dot')).not.toBeNull()
  await act(async()=>selected.click())
  expect(selected.querySelector('.workspace-unread-dot')).toBeNull()
  expect(selected.querySelector('.session-status-badge')?.getAttribute('data-status')).toBe('completed')
  expect(selected.getAttribute('aria-label')).toContain('선택됨')
  act(()=>useStore.setState(s=>({sessions:{...s.sessions,'1':{...s.sessions['1'],aiState:'working'}}})))
  expect(selected.querySelector('.session-status-badge')?.getAttribute('data-status')).toBe('working')
})

it('shows idle for a fresh session and never calls an offline session completed',()=>{
  act(()=>useStore.setState(s=>({sessions:{...s.sessions,'2':{...s.sessions['2'],completionEvent:'',completionId:''}}})))
  expect(host.querySelector('[data-state=idle] .session-status-badge')?.getAttribute('data-status')).toBe('idle')
  act(()=>useStore.setState({connection:'offline'}))
  expect(host.querySelector('[data-status=completed]')).toBeNull()
  expect(host.querySelectorAll('[data-status=disconnected]')).toHaveLength(3)
})
it('filters sessions without changing workspace order and follows live state transitions',async()=>{
  await act(async()=>host.querySelector<HTMLButtonElement>('.filter-working')!.click())
  expect(host.querySelectorAll('.workspace-session')).toHaveLength(1)
  expect(host.querySelectorAll('.workspace-session-group')).toHaveLength(1)
  expect(useStore.getState().workspaceOrder).toEqual([])
  act(()=>useStore.setState(s=>({sessions:{...s.sessions,'1':{...s.sessions['1'],aiState:'idle'}}})))
  expect(host.querySelectorAll('.workspace-session')).toHaveLength(0)
  expect(host.textContent).toContain('작업 중인 세션이 없습니다.')
  await act(async()=>host.querySelector<HTMLButtonElement>('.filter-all')!.click())
  expect(host.querySelectorAll('.workspace-session')).toHaveLength(3)
})
it('removes working indicators on disconnection and excludes hidden sessions from counts',async()=>{
  act(()=>useStore.setState({connection:'offline'}))
  expect(host.querySelectorAll('[data-state=working]')).toHaveLength(0)
  expect(host.querySelector('.filter-working b')?.textContent).toBe('0')
  expect(host.querySelectorAll('[data-state=disconnected]')).toHaveLength(3)
  act(()=>useStore.setState({_sessionStateRevision:-1,connection:'online',hiddenSessions:[completionKey(useStore.getState().sessions['1'])]}))
  expect(host.querySelector('.filter-all b')?.textContent).toBe('2')
  expect(host.querySelector('.filter-working b')?.textContent).toBe('0')
  expect(host.querySelector('.workspace-activity-working')).toBeNull()
  expect(host.querySelector('.filter-completed b')?.textContent).toBe('0')
})

it('filters unread results independently of current activity and clears only the selected result',async()=>{
  act(()=>markUnread(['1','2']))
  expect(host.querySelector('.filter-completed b')?.textContent).toBe('2')
  expect(host.querySelector('.workspace-activity-completed')?.getAttribute('aria-label')).toBe('미확인 완료 2개')
  expect(host.querySelector('[data-completed=true] .workspace-session-status > span:last-child')?.textContent).toBe('완료')
  await act(async()=>host.querySelector<HTMLButtonElement>('.filter-completed')!.click())
  expect(host.querySelectorAll('.workspace-session')).toHaveLength(2)
  expect(host.querySelector('[data-state=working] .workspace-session-status > span:last-child')?.textContent).toBe('작업 중')
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-completed=true]')!.click())
  expect(useStore.getState().activeId).toBe('2')
  expect(host.querySelector('.filter-completed b')?.textContent).toBe('1')
  expect(host.querySelectorAll('.workspace-session')).toHaveLength(1)
  expect(useStore.getState().unreadCompletions).toEqual([completionKey(useStore.getState().sessions['1'])])
  await act(async()=>host.querySelector<HTMLButtonElement>('.workspace-session')!.click())
  expect(host.textContent).toContain('확인하지 않은 완료 결과가 없습니다.')
  await act(async()=>host.querySelector<HTMLButtonElement>('.filter-all')!.click())
  expect(host.querySelectorAll('.workspace-session')).toHaveLength(3)
  expect(host.querySelector('[data-state=idle] .workspace-session-status > span:last-child')?.textContent).toBe('완료')
})

it('does not acknowledge other results when a workspace restores a file or one terminal',async()=>{
  const key=workspaceId('/project')
  act(()=>markUnread(['1','2']))
  act(()=>useStore.setState({_viewerState:{[key]:{
    activeTabId:'file',tabs:[{id:'file',path:'/project/a.md',name:'a.md',content:'',lang:'',type:'markdown'}],
  }}}))
  await act(async()=>host.querySelector<HTMLButtonElement>('.workspace-picker-select')!.click())
  expect(useStore.getState().unreadCompletions).toHaveLength(2)
  expect(useStore.getState()._viewerState[key].activeTabId).toBe('file')
  act(()=>useStore.getState().setActive('2'))
  await act(async()=>host.querySelector<HTMLButtonElement>('.workspace-picker-select')!.click())
  expect(useStore.getState().unreadCompletions).toEqual([completionKey(useStore.getState().sessions['1'])])
})

it('opens a matching result from the filtered workspace header without acknowledging its siblings',async()=>{
  act(()=>useStore.setState(s=>({sessions:{...s.sessions,'4':session('4','idle')},unreadCompletions:[completionKey(s.sessions['2']),completionKey(session('4','idle'))]})))
  act(()=>markUnread(['2','4']))
  await act(async()=>host.querySelector<HTMLButtonElement>('.filter-completed')!.click())
  await act(async()=>host.querySelector<HTMLButtonElement>('.workspace-picker-select')!.click())
  expect(useStore.getState().activeId).toBe('2')
  expect(host.querySelectorAll('.workspace-session')).toHaveLength(1)
  expect(host.querySelector('.workspace-session')?.textContent).toContain('Session 4')
})

it('updates completion counts for new events without recreating acknowledged results on replay',async()=>{
  act(()=>useStore.setState({unreadCompletions:[]}))
  const s=useStore.getState()
  act(()=>s.handleMessage(serverState(['2'],{'2':{completionEvent:'result-a'}})))
  expect(host.querySelector('.filter-completed b')?.textContent).toBe('1')
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-completed=true]')!.click())
  act(()=>{
    s.handleMessage({type:'aiState',id:'2',state:'working',completionId:'result-a'})
    s.handleMessage({type:'aiState',id:'2',state:'idle',completionId:'result-a'})
  })
  expect(host.querySelector('.filter-completed b')?.textContent).toBe('0')
  act(()=>s.handleMessage(serverState(['2'],{'2':{completionEvent:'result-b'}})))
  expect(host.querySelector('.filter-completed b')?.textContent).toBe('1')
  act(()=>useStore.setState({connection:'offline'}))
  await act(async()=>host.querySelector<HTMLButtonElement>('.filter-completed')!.click())
  expect(host.querySelectorAll('[data-state=disconnected]')).toHaveLength(1)
  expect(host.querySelector('.filter-completed b')?.textContent).toBe('1')
})
