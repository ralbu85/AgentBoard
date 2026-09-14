import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {editNotebook, loadServerNotebook, notebookAction, openNotebook, refreshNotebook, useNotebooks, checkNotebookFile, type NotebookState} from './notebookRuntime'

const path='/fixture/test.ipynb'
let state:NotebookState
let calls:string[]
beforeEach(()=>{
  vi.useFakeTimers()
  useNotebooks.setState({records:{}})
  state={id:'fixture',path,content:'original',revision:1,version:'file-v1',dirty:false,state:'stopped',cell:null,error:'',kernel:false,python:'python'}
  calls=[]
  vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
    calls.push((options?.method||'GET')+' '+url)
    const body=options?.body?JSON.parse(options.body as string):{}
    if(options?.method==='PUT'){
      if(body.revision!==state.revision)return {ok:false,status:409,json:async()=>({detail:'conflict'})}
      state={...state,content:body.content,revision:state.revision+1,dirty:true}
    }
    if(url.endsWith('/action'))state={...state,revision:state.revision+1,state:'running'}
    return {ok:true,json:async()=>({...state})}
  }))
})
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})

describe('notebook runtime',()=>{
  it('flushes pending edits before execution and shares state across reopened tabs',async()=>{
    await openNotebook(path,'original',false)
    editNotebook(path,'edited')
    await notebookAction(path,'execute',0)
    expect(calls.slice(-2)).toEqual(['PUT /api/notebooks/fixture','POST /api/notebooks/fixture/action'])
    expect(state.content).toBe('edited')
    const count=calls.length
    await openNotebook(path,'old disk content',false)
    expect(calls.length).toBe(count)
    expect(useNotebooks.getState().records[path].content).toBe('edited')
  })
  it('syncs edits without a mounted viewer',async()=>{
    await openNotebook(path,'original',false)
    editNotebook(path,'draft')
    await vi.advanceTimersByTimeAsync(501)
    expect(state.content).toBe('draft')
  })
  it('keeps local edits on conflicting remote updates until explicit reload',async()=>{
    await openNotebook(path,'original',false)
    editNotebook(path,'my draft')
    state={...state,content:'another client',revision:2}
    await refreshNotebook(path)
    expect(useNotebooks.getState().records[path].content).toBe('my draft')
    expect(useNotebooks.getState().records[path].conflict).toBe(true)
    await expect(notebookAction(path,'save')).rejects.toThrow()
    expect(state.content).toBe('another client')
    await loadServerNotebook(path)
    expect(useNotebooks.getState().records[path].content).toBe('another client')
    expect(useNotebooks.getState().records[path].conflict).toBe(false)
  })
  it('reopens the recovery draft after the backend restarts',async()=>{
    await openNotebook(path,'original',false)
    vi.mocked(fetch).mockResolvedValueOnce({ok:false,status:404,json:async()=>({detail:'reopen'})} as Response)
    state={...state,content:'recovered output',revision:100,dirty:true}
    await refreshNotebook(path)
    expect(useNotebooks.getState().records[path].content).toBe('recovered output')
    expect(calls[calls.length-1]).toBe('POST /api/notebooks/open')
  })
  it('shows an operation immediately and polls server progress during a slow request',async()=>{
    await openNotebook(path,'original',false)
    let release!:()=>void
    const gate=new Promise<void>(resolve=>{release=resolve})
    const original=vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async(...args)=>{
      if(String(args[0]).endsWith('/action'))await gate
      return original(...args)
    })
    const action=notebookAction(path,'connect')
    expect(useNotebooks.getState().records[path].operation?.action).toBe('connect')
    await Promise.resolve();await Promise.resolve()
    state={...state,state:'starting',revision:2}
    await refreshNotebook(path)
    expect(useNotebooks.getState().records[path].observed?.state).toBe('starting')
    expect(useNotebooks.getState().records[path].server.revision).toBe(1)
    release();await action
    expect(useNotebooks.getState().records[path].operation).toBeUndefined()
    expect(useNotebooks.getState().records[path].notice).toBe('커널 연결 완료')
  })

  it('clears a recovered polling error even when the revision did not change',async()=>{
    await openNotebook(path,'original',false)
    vi.mocked(fetch).mockRejectedValueOnce(Error('offline'))
    await refreshNotebook(path)
    expect(useNotebooks.getState().records[path].connectionError).toBe('offline')
    vi.mocked(fetch).mockResolvedValueOnce({ok:true,json:async()=>({unchanged:true})} as Response)
    await refreshNotebook(path)
    expect(useNotebooks.getState().records[path].connectionError).toBe('')
  })
  it('retries an unsynced draft after the connection recovers without another keystroke',async()=>{
    await openNotebook(path,'original',false)
    editNotebook(path,'offline draft')
    vi.mocked(fetch).mockRejectedValueOnce(Error('offline'))
    await vi.advanceTimersByTimeAsync(501)
    expect(state.content).toBe('original')
    expect(useNotebooks.getState().records[path].content).toBe('offline draft')
    await refreshNotebook(path)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.content).toBe('offline draft')
    expect(useNotebooks.getState().records[path].error).toBe('')
  })

  it('detects external versions without replacing local drafts and avoids repeated full reads',async()=>{
    await openNotebook(path,'original',false)
    editNotebook(path,'my draft')
    let fullReads=0
    const original=vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async(...args)=>{
      const url=String(args[0])
      if(url.startsWith('/api/files?'))return {ok:true,json:async()=>({entries:[{name:'test.ipynb',mtime:1,size:10}]})} as Response
      if(url.startsWith('/api/file?')){fullReads++;return {ok:true,json:async()=>({version:'external-version',content:'agent changes'})} as Response}
      return original(...args)
    })
    await checkNotebookFile(path,true)
    expect(useNotebooks.getState().records[path].fileChanged).toBe(true)
    expect(useNotebooks.getState().records[path].content).toBe('my draft')
    await checkNotebookFile(path)
    expect(fullReads).toBe(1)
    // A successful save/reload establishes a new original version.
    useNotebooks.setState(s=>({records:{...s.records,[path]:{...s.records[path],server:{...s.records[path].server,version:'external-version'}}}}))
    await checkNotebookFile(path)
    expect(useNotebooks.getState().records[path].fileChanged).toBe(false)
  })

})
