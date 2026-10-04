// Run in the dedicated container, never in the server's root account.
const fs=require('node:fs')
const {chromium}=require('playwright-core')
;(async()=>{
  if(process.getuid?.()===0)throw Error('Browser worker refuses root')
  const wsPath=fs.readFileSync('/run/secrets/browser_ws_path','utf8').trim()
  if(!/^[a-f0-9]{64}$/.test(wsPath))throw Error('Missing private worker path')
  const browser=await chromium.launchServer({headless:true,chromiumSandbox:true,host:'0.0.0.0',port:3000,wsPath})
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void browser.close().finally(()=>process.exit()))
  browser.on('close',()=>process.exit())
  console.log('Sandboxed browser worker ready') // Never log the endpoint secret.
})().catch(()=>{console.error('Sandboxed browser worker could not start; no insecure fallback');process.exit(1)})
