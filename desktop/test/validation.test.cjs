const {test}=require('node:test')
const assert=require('node:assert/strict')
const {webUrl,identity}=require('../browser.cjs')

test('web navigation cannot select files, scripts, credentials or external protocols',()=>{
  for(const url of ['file:///etc/passwd','javascript:alert(1)','data:text/html,test','mailto:x@example.com','https://user:password@example.com','https://example.com/\n'])assert.throws(()=>webUrl(url))
  assert.equal(webUrl('http://localhost:3000'),'http://localhost:3000/')
  assert.equal(webUrl('https://example.com'),'https://example.com/')
})
test('tab identity and workspace cannot choose profile paths',()=>{
  identity('browser:test-123','["local","/project"]')
  for(const [id,owner] of [['../../file','["local","/project"]'],['browser:x','{}'],['browser:x','[1,2]'],['browser:x','["","/project"]']])assert.throws(()=>identity(id,owner))
})
