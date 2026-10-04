const {test}=require('node:test')
const assert=require('node:assert/strict')
const {assertBrowserSafety}=require('../browser-security.cjs')
test('root and sandbox bypasses are refused, including integration tests',()=>{
  assert.throws(()=>assertBrowserSafety({uid:0,args:[],env:{}}),/root/)
  for(const arg of ['--no-sandbox','--disable-namespace-sandbox','--disable-seccomp-filter-sandbox','--disable-web-security'])assert.throws(()=>assertBrowserSafety({uid:1000,args:[arg],env:{}}))
  assert.throws(()=>assertBrowserSafety({uid:1000,args:[],env:{ELECTRON_DISABLE_SANDBOX:'1'}}))
  assert.doesNotThrow(()=>assertBrowserSafety({uid:1000,args:[],env:{}}))
  assert.doesNotThrow(()=>assertBrowserSafety({uid:null,args:[],env:{}}))
})
test('demo launchers also refuse root before starting any browser',async()=>{
  const helper=require('../../tools/demo/safe-browser.cjs')
  if(process.getuid?.()!==0)return
  let launched=false
  await assert.rejects(()=>helper.launchBrowser({launch:()=>{launched=true}}),/root/)
  assert.equal(launched,false)
})
