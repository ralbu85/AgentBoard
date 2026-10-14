import {act,createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {SessionTabs} from './SessionTabs'
import {useStore, completionKey} from '../../store'
import type {Session} from '../../types'

vi.mock('../../ws',()=>({notifyActive:vi.fn()}))

let root:Root, host:HTMLDivElement
beforeEach(()=>{
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  const session:Session={id:'1',host:'local',cwd:'/project',sessionName:'one',cmd:'codex',status:'running',aiState:'working',process:'codex',createdAt:1,memKB:0,completionEvent:'previous'}
  useStore.setState({sessions:{'1':session},titles:{},connection:'online',activeId:'1',workspaceHost:'local',hiddenSessions:[],profiles:[],unreadCompletions:[completionKey(session)]})
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
  act(()=>root.render(createElement(SessionTabs,{wsCwd:'/project'})))
})
afterEach(()=>{act(()=>root.unmount());host.remove()})

it('shows current activity beside the selected tab without repeating sidebar unread markers',()=>{
  expect(host.querySelector('[role=tab]')?.getAttribute('aria-selected')).toBe('true')
  expect(host.querySelector('[data-status=working]')).not.toBeNull()
  expect(host.textContent).not.toContain('미확인')
  act(()=>useStore.setState(s=>({sessions:{...s.sessions,'1':{...s.sessions['1'],aiState:'idle'}},unreadCompletions:[]})))
  expect(host.querySelector('[data-status=completed]')).not.toBeNull()
  act(()=>useStore.setState({connection:'offline'}))
  expect(host.querySelector('[data-status=disconnected]')).not.toBeNull()
  expect(host.querySelector('[data-status=working]')).toBeNull()
})
