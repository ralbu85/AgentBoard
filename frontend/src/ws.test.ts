import {afterEach, beforeEach, expect, it, vi} from 'vitest'

const state = vi.hoisted(()=>({activeId:null, connection:'offline', handleMessage:vi.fn()}))
vi.mock('./store',()=>({useStore:{getState:()=>state,setState:(next:object)=>Object.assign(state,next)}}))

class Socket {
  static CONNECTING=0
  static OPEN=1
  static CLOSING=2
  static CLOSED=3
  static instances:Socket[]=[]
  readyState=0
  sent:object[]=[]
  onopen:(()=>void)|null=null
  onmessage:((event:{data:string})=>void)|null=null
  onclose:((event:{code:number})=>void)|null=null
  constructor(_url:string){Socket.instances.push(this)}
  send(data:string){this.sent.push(JSON.parse(data))}
  close(){this.readyState=Socket.CLOSING} // Simulate a half-open TCP connection.
  open(){this.readyState=Socket.OPEN;this.onopen?.()}
  receive(msg:object){this.onmessage?.({data:JSON.stringify(msg)})}
}

let listeners:Array<[EventTarget,string,EventListenerOrEventListenerObject]> = []
beforeEach(()=>{
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket',Socket)
  vi.spyOn(document,'visibilityState','get').mockReturnValue('visible')
  Socket.instances=[]
  state.connection='offline'
  state.handleMessage.mockClear()
  for(const target of [document,window]) {
    const add=target.addEventListener.bind(target)
    vi.spyOn(target,'addEventListener').mockImplementation(((type:string,listener:EventListenerOrEventListenerObject,options?:boolean)=>{
      listeners.push([target,type,listener]);add(type,listener,options)
    }) as typeof target.addEventListener)
  }
})
afterEach(()=>{
  for(const [target,type,listener] of listeners) target.removeEventListener(type,listener)
  listeners=[]
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('marks online only after authoritative state and refreshes when returning to the app',async()=>{
  const {initWs}=await import('./ws')
  initWs()
  const socket=Socket.instances[0]
  socket.open()
  expect(state.connection).toBe('connecting')
  expect(socket.sent).toContainEqual({type:'session-sync'})
  socket.receive({type:'session-state',revision:1,sessions:[]})
  expect(state.connection).toBe('online')
  socket.sent=[]
  window.dispatchEvent(new Event('pageshow'))
  expect(socket.sent).toEqual([{type:'session-sync'}])
  socket.receive({type:'session-state',revision:2,sessions:[]})
  vi.advanceTimersByTime(15000)
  expect(socket.sent).toHaveLength(2)
})

it('replaces a silent connection even when close never returns, and ignores its stale callbacks',async()=>{
  const {initWs}=await import('./ws')
  initWs()
  const old=Socket.instances[0]
  old.open()
  vi.advanceTimersByTime(8000)
  expect(Socket.instances).toHaveLength(2)
  const current=Socket.instances[1]
  current.open()
  current.receive({type:'session-state',revision:20,sessions:[]})
  old.receive({type:'session-state',revision:1,sessions:[]})
  old.onclose?.({code:1006})
  expect(state.connection).toBe('online')
  expect(state.handleMessage).toHaveBeenCalledTimes(1)
  expect(state.handleMessage).toHaveBeenCalledWith({type:'session-state',revision:20,sessions:[]})
})

it('pauses synchronization deadlines while hidden and resumes on mobile foreground',async()=>{
  const {initWs}=await import('./ws')
  initWs()
  const socket=Socket.instances[0]
  socket.open()
  vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  vi.advanceTimersByTime(60000)
  expect(Socket.instances).toHaveLength(1)
  socket.sent=[]
  vi.spyOn(document,'visibilityState','get').mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(socket.sent).toEqual([{type:'session-sync'}])
})
