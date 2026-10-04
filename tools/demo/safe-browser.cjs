const {assertBrowserSafety}=require('../../desktop/browser-security.cjs')
exports.launchBrowser=async chromium=>{
  assertBrowserSafety()
  return chromium.launch({executablePath:process.env.AGENTBOARD_DEMO_CHROME||'/usr/bin/google-chrome',chromiumSandbox:true})
}
