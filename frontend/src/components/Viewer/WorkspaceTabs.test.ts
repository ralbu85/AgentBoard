import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceTabs } from './WorkspaceTabs'
import type { ViewerTab } from '../../store'
import {useStore} from '../../store'

let root: Root, host: HTMLDivElement
const tab=(id:string,type:ViewerTab['type']='code',dirty=false):ViewerTab=>({id,name:id,path:'/project/'+id,content:'',type,lang:'',dirty})
const tabs=[tab('current.py'),tab('saved.py'),tab('draft.py','code',true),tab('terminal:1','terminal'),tab('browser:1','browser')]
beforeEach(()=>{
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}})
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
})
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals()})
function mount() {
  const onSelect=vi.fn(),onClose=vi.fn()
  act(()=>root.render(createElement(WorkspaceTabs,{tabs,paneIds:tabs.map(t=>t.id),activeId:'current.py',onSelect,onClose,onDrop:vi.fn(),actions:null})))
  act(()=>host.querySelector<HTMLButtonElement>('.workspace-tabs-toggle')!.click())
  return {onSelect,onClose}
}
it('updates existing terminal tabs from shared task summaries without reopening tabs',()=>{
  useStore.setState({_sessionStateRevision:-1,sessions:{},titles:{}})
  useStore.getState().upsertSession({id:'1',cwd:'/project',cmd:'codex'})
  const session={...useStore.getState().sessions['1'],taskTitle:'첫 작업',autoTitle:'오래된 제목'}
  useStore.getState().applySessionState({type:'session-state',revision:1,sessions:[session]})
  const terminal={...tab('terminal:1','terminal'),sessionId:'1'}
  const onSelect=vi.fn(),onClose=vi.fn()
  act(()=>root.render(createElement(WorkspaceTabs,{tabs:[terminal],paneIds:[terminal.id],activeId:terminal.id,onSelect,onClose,onDrop:vi.fn(),actions:null})))
  expect(host.querySelector('.vtab-name')?.textContent).toBe('첫 작업')
  act(()=>useStore.getState().applySessionState({type:'session-state',revision:2,sessions:[{...session,taskTitle:'새 요청'}]}))
  expect(host.querySelectorAll('[role=tab]')).toHaveLength(1)
  expect(host.querySelector('.vtab-name')?.textContent).toBe('새 요청')
  expect(onSelect).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})

it('shows the same activity on tabs and their menu while keeping selection and unread independent',()=>{
  useStore.setState({_sessionStateRevision:-1,sessions:{},titles:{},connection:'online'})
  useStore.getState().upsertSession({id:'1',cwd:'/project',cmd:'codex'})
  const session={...useStore.getState().sessions['1'],aiState:'working',completionEvent:'previous',completionUnread:true}
  useStore.getState().applySessionState({type:'session-state',revision:1,sessions:[session]})
  const terminal={...tab('terminal:1','terminal'),sessionId:'1'}
  act(()=>root.render(createElement(WorkspaceTabs,{tabs:[terminal],paneIds:[terminal.id],activeId:terminal.id,onSelect:vi.fn(),onClose:vi.fn(),onDrop:vi.fn(),actions:null})))
  expect(host.querySelector('[role=tab]')?.getAttribute('aria-selected')).toBe('true')
  expect(host.querySelector('.session-status-badge')?.getAttribute('data-status')).toBe('working')
  expect(host.textContent).not.toContain('미확인')
  act(()=>useStore.getState().applySessionState({type:'session-state',revision:2,sessions:[{...session,aiState:'idle',completionUnread:false}]}))
  expect(host.querySelector('.session-status-badge')?.getAttribute('data-status')).toBe('completed')
  act(()=>host.querySelector<HTMLButtonElement>('.workspace-tabs-toggle')!.click())
  expect(document.querySelector('.workspace-tabs-popup .session-status-badge')?.getAttribute('data-status')).toBe('completed')
  expect(document.querySelector('.tab-selected-label')?.textContent).toBe('선택됨')
  act(()=>useStore.setState({connection:'offline'}))
  expect(host.querySelector('.session-status-badge')?.getAttribute('data-status')).toBe('disconnected')
})
it('filters the workspace list and protects active, dirty, terminal, and browser tabs from file cleanup',()=>{
  const {onClose}=mount()
  const popup=document.querySelector('.workspace-tabs-popup')!
  const fileFilter=Array.from(popup.querySelectorAll<HTMLButtonElement>('.workspace-tabs-filters button')).find(b=>b.textContent?.startsWith('파일'))!
  act(()=>fileFilter.click())
  expect(popup.querySelectorAll('.workspace-tab-row')).toHaveLength(3)
  act(()=>popup.querySelector<HTMLButtonElement>('.workspace-tabs-footer button')!.click())
  expect(onClose.mock.calls).toEqual([['saved.py']])
})
it('keeps tab selection separate from closing, and exposes unsaved changes',()=>{
  const {onSelect,onClose}=mount()
  act(()=>document.querySelector<HTMLButtonElement>('.workspace-tab-dismiss')!.click())
  expect(onClose).toHaveBeenCalledWith('current.py')
  expect(onSelect).not.toHaveBeenCalled()
  expect(host.querySelector('[data-tab-id="draft.py"]')?.getAttribute('aria-label')).toContain('수정 중')
  expect(host.querySelector('[aria-selected=true]')?.getAttribute('data-tab-id')).toBe('current.py')
})
it('supports keyboard tab navigation and dismisses the list with Escape',()=>{
  const {onSelect}=mount()
  act(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  expect(document.querySelector('.workspace-tabs-popup')).toBeNull()
  expect(document.activeElement).toBe(host.querySelector('.workspace-tabs-toggle'))
  act(()=>host.querySelector('[role=tab]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})))
  expect(onSelect).toHaveBeenCalledWith('saved.py')
})
