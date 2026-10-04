const unsafe=new Set(['no-sandbox','disable-setuid-sandbox','disable-namespace-sandbox','disable-seccomp-filter-sandbox','disable-web-security'])
function assertBrowserSafety({uid=process.getuid?.(),args=process.argv,env=process.env}={}){
  if(uid===0)throw Error('브라우저는 root 계정으로 실행할 수 없습니다. 일반 사용자 계정을 사용하세요.')
  if(env.ELECTRON_DISABLE_SANDBOX||args.some(arg=>unsafe.has(arg.replace(/^--/,'').split('=')[0])))throw Error('브라우저 샌드박스를 끄는 설정은 허용하지 않습니다.')
}
module.exports={assertBrowserSafety}
