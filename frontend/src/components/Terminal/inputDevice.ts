interface InputDevice {
  userAgent:string
  platform:string
  maxTouchPoints?:number
  userAgentData?:{mobile?:boolean}
}

// Touch/coarse pointers also exist on desktop PCs. Keep the phone's input
// policy separate from the terminal renderer's pointer/viewport preference.
export function isMobileInputDevice(device:InputDevice=navigator):boolean {
  return device.userAgentData?.mobile===true
    || /Android|iPhone|iPad|iPod/i.test(device.userAgent)
    || (device.platform==='MacIntel'&&(device.maxTouchPoints||0)>1)
}
