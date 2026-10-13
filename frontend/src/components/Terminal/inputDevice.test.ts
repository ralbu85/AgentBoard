import {expect,it} from 'vitest'
import {isMobileInputDevice} from './inputDevice'

it.each([
  {platform:'Win32',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',maxTouchPoints:10},
  {platform:'Linux x86_64',userAgent:'Mozilla/5.0 (X11; Linux x86_64)',maxTouchPoints:5},
  {platform:'MacIntel',userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',maxTouchPoints:0},
])('keeps desktop keyboard input on $platform including touch PCs',device=>{
  expect(isMobileInputDevice(device)).toBe(false)
})

it.each([
  {platform:'iPhone',userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'},
  {platform:'Linux armv8l',userAgent:'Mozilla/5.0 (Linux; Android 15; Phone) Mobile'},
  {platform:'Linux armv8l',userAgent:'Mozilla/5.0 (Linux; Android 15; Tablet)',userAgentData:{mobile:false}},
  {platform:'MacIntel',userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',maxTouchPoints:5},
  {platform:'',userAgent:'',userAgentData:{mobile:true}},
])('preserves phone/tablet input independently of pointer and window size ($platform)',device=>{
  expect(isMobileInputDevice(device)).toBe(true)
})
