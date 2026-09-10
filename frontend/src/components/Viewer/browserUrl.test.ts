import {expect,it} from 'vitest'
import {browserUrl} from './browserUrl'
it('normalizes web addresses and local development URLs',()=>{
  expect(browserUrl('example.com/docs')).toBe('https://example.com/docs')
  expect(browserUrl('localhost:3000')).toBe('http://localhost:3000/')
  expect(browserUrl('http://127.0.0.1:8888/lab')).toBe('http://127.0.0.1:8888/lab')
  expect(browserUrl(' https://example.com/?q=한글 ')).toContain('https://example.com/')
})
it('rejects executable schemes, local files, credentials and malformed input',()=>{
  for(const value of ['javascript:alert(1)','data:text/html,x','file:///etc/passwd','ftp://example.com','https://user:password@example.com','hello world',''])expect(browserUrl(value)).toBeNull()
})
