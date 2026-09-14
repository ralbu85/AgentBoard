import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {editNotebook, loadServerNotebook, notebookAction, openNotebook, refreshNotebook, useNotebooks, type NotebookState} from './notebookRuntime'

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
})
