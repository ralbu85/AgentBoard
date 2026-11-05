import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {autosaveNotebook, editNotebook, loadServerNotebook, notebookAction, openNotebook, refreshNotebook, useNotebooks, checkNotebookFile, type NotebookState} from './notebookRuntime'

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
    if(url.endsWith('/action')&&body.action==='save')state={...state,revision:state.revision+1,dirty:false,version:'file-v2'}
    else if(url.endsWith('/action'))state={...state,revision:state.revision+1,state:body.action==='shutdown'?'stopped':'running',...(body.action==='shutdown'?{kernel:false}:{})}
    return {ok:true,json:async()=>({...state})}
  }))
})
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})

describe('notebook runtime',()=>{
  it('resets outputs and kernel after syncing the draft, preserving sources and metadata',async()=>{
    const cells=[{cell_type:'code',source:'x = 42',outputs:[{text:'42'}],execution_count:3,metadata:{keep:true}},
      {cell_type:'markdown',source:'# Notes',metadata:{}}]
    state={...state,kernel:true,state:'idle',content:JSON.stringify({cells,metadata:{name:'fixture'}})}
    await openNotebook(path,state.content,false)
    cells[0].source='x = 43'
    editNotebook(path,JSON.stringify({cells,metadata:{name:'fixture'}}))
    await notebookAction(path,'reset')
    expect(calls.slice(-3)).toEqual(['PUT /api/notebooks/fixture','POST /api/notebooks/fixture/action','PUT /api/notebooks/fixture'])
    const result=JSON.parse(state.content)
    expect(result.cells[0]).toEqual({...cells[0],outputs:[],execution_count:null})
    expect(result.cells[1]).toEqual(cells[1])
    expect(result.metadata).toEqual({name:'fixture'})
    expect(state.kernel).toBe(false)
    expect(state.dirty).toBe(true)
  })
  it('keeps outputs if stopping the kernel fails during reset',async()=>{
    const original=JSON.stringify({cells:[{cell_type:'code',source:'42',outputs:[{text:'42'}],execution_count:1}]})
    state={...state,content:original,kernel:true,state:'idle'}
    await openNotebook(path,original,false)
    vi.mocked(fetch).mockRejectedValueOnce(Error('connection lost'))
    await expect(notebookAction(path,'reset')).rejects.toThrow('connection lost')
    expect(useNotebooks.getState().records[path].content).toBe(original)
    expect(useNotebooks.getState().records[path].operation).toBeUndefined()
  })
  it.each(['execute','run-to-cell'])('flushes pending edits before %s and shares state across reopened tabs',async(action)=>{
    await openNotebook(path,'original',false)
    editNotebook(path,'edited')
    await notebookAction(path,action,0)
    const requestBody=JSON.parse(vi.mocked(fetch).mock.calls[vi.mocked(fetch).mock.calls.length-1][1]!.body as string)
    expect(requestBody).toMatchObject({action,cell:0,revision:2})
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
      if(url.startsWith('/api/file-stat?'))return {ok:true,status:200,json:async()=>({signature:'1:10:7'})} as Response
      if(url.startsWith('/api/file?')){fullReads++;return {ok:true,status:200,json:async()=>({version:'external-version',content:'agent changes'})} as Response}
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

  it('autosaves quietly, leaving cells editable, and never over a changed file or a running cell',async()=>{
    await openNotebook(path,'original',false)
    editNotebook(path,'edited')
    const saving=autosaveNotebook(path)
    expect(useNotebooks.getState().records[path].operation).toBeUndefined()
    await saving
    expect(calls.slice(-2)).toEqual(['PUT /api/notebooks/fixture','POST /api/notebooks/fixture/action'])
    expect(useNotebooks.getState().records[path].server).toMatchObject({dirty:false,version:'file-v2',content:'edited'})
    const count=calls.length
    editNotebook(path,'more')
    useNotebooks.setState(s=>({records:{...s.records,[path]:{...s.records[path],fileChanged:true}}}))
    await autosaveNotebook(path)
    useNotebooks.setState(s=>({records:{...s.records,[path]:{...s.records[path],fileChanged:false,server:{...s.records[path].server,state:'running'}}}}))
    await autosaveNotebook(path)
    expect(calls.length).toBe(count)
  })
})
