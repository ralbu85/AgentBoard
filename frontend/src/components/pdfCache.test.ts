import {beforeEach, expect, it, vi} from 'vitest'
const mocks = vi.hoisted(() => ({destroy: vi.fn(), parse: vi.fn()}))
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: mocks.parse,
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({default:'/worker.js'}))
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks()
  mocks.destroy.mockResolvedValue(undefined)
  mocks.parse.mockImplementation(() => ({destroy:mocks.destroy, promise:Promise.resolve({numPages:2,getPage:async (n:number)=>({pageNumber:n})})}))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok:true,arrayBuffer:async()=>new ArrayBuffer(8)}))
})
it('shares concurrent loads and reuses parsed pages after tab release', async () => {
  const {acquirePdf,peekPdf} = await import('./pdfCache')
  const a=acquirePdf('/a.pdf'), b=acquirePdf('/a.pdf')
  expect(a.ready).toBe(b.ready)
  const data=await a.ready; a.release(); b.release()
  const c=acquirePdf('/a.pdf')
  expect(await c.ready).toBe(data)
  expect(peekPdf('/a.pdf')).toBe(data)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(mocks.parse).toHaveBeenCalledTimes(1)
  expect(mocks.destroy).not.toHaveBeenCalled(); c.release()
})
it('refreshes explicitly without destroying another mounted viewer', async () => {
  const {acquirePdf} = await import('./pdfCache')
  const a=acquirePdf('/a.pdf'); await a.ready
  const b=acquirePdf('/a.pdf',true); await b.ready
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(mocks.destroy).not.toHaveBeenCalled()
  a.release(); expect(mocks.destroy).toHaveBeenCalledTimes(1); b.release()
})
it('evicts the least recently used unmounted document', async () => {
  const {acquirePdf,peekPdf}=await import('./pdfCache')
  const active=acquirePdf('/active.pdf'); await active.ready
  for(let i=0;i<5;i++){const item=acquirePdf('/'+i+'.pdf');await item.ready;item.release()}
  expect(peekPdf('/active.pdf')).toBeDefined()
  expect(peekPdf('/0.pdf')).toBeUndefined()
  expect(peekPdf('/4.pdf')).toBeDefined()
  expect(mocks.destroy).toHaveBeenCalled();active.release()
})
it('does not cache failed fetches and allows retry', async () => {
  const {acquirePdf}=await import('./pdfCache')
  vi.mocked(fetch).mockResolvedValueOnce({ok:false,status:503} as Response)
  const a=acquirePdf('/a.pdf');await expect(a.ready).rejects.toThrow('503');a.release()
  const b=acquirePdf('/a.pdf');await b.ready;b.release()
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('releases an oversized document after its viewer is closed', async () => {
  const {acquirePdf,peekPdf}=await import('./pdfCache')
  vi.mocked(fetch).mockResolvedValueOnce({ok:true,arrayBuffer:async()=>({byteLength:70*1024*1024})} as Response)
  const a=acquirePdf('/large.pdf');await a.ready
  expect(peekPdf('/large.pdf')).toBeDefined();a.release()
  expect(peekPdf('/large.pdf')).toBeUndefined()
})
