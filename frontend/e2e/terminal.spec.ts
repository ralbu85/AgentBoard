import {test,expect} from '@playwright/test'

test.beforeEach(async({page})=>{
  await page.route('**/api/**',route=>route.fulfill({json:{ok:true}}))
  await page.goto('/e2e/terminal-fixture.html')
})

test('fits the viewport before and after rotation without horizontal scrolling',async({page})=>{
  for(const size of [{width:390,height:844},{width:844,height:390},{width:430,height:932}]){
    await page.setViewportSize(size)
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    await expect.poll(()=>page.evaluate(()=>{const el=document.querySelector('.xterm-wrap')!;return el.scrollWidth<=el.clientWidth+1})).toBe(true)
  }
})

test('phone keeps native selection and reading position while output changes',async({page},info)=>{
  test.skip(info.project.name!=='phone')
  const output=page.locator('.mobile-output-scroll')
  await expect(output).toBeVisible()
  const selected=await page.evaluate(()=>{
    const el=document.querySelector<HTMLElement>('.mobile-output-scroll')!;el.scrollTop=300
    const row=el.querySelectorAll('.mobile-terminal-line')[15]
    const range=document.createRange();range.selectNodeContents(row)
    getSelection()!.removeAllRanges();getSelection()!.addRange(range)
    return getSelection()!.toString()
  })
  await page.evaluate(()=>{(window as any).fixture.update()})
  await expect.poll(()=>page.evaluate(()=>getSelection()!.toString())).toBe(selected)
  await expect.poll(()=>output.evaluate(el=>el.scrollTop)).toBe(300)
})

test('phone Enter inserts a newline and Send submits the full draft once',async({page},info)=>{
  test.skip(info.project.name!=='phone')
  const sent:unknown[]=[]
  await page.route('**/api/paste',async route=>{sent.push(route.request().postDataJSON());await route.fulfill({json:{ok:true}})})
  const input=page.locator('textarea.input-textarea')
  await input.fill('first');await input.press('Enter');await input.pressSequentially('second')
  await expect(input).toHaveValue('first\nsecond');expect(sent).toHaveLength(0)
  await page.getByRole('button',{name:'Send',exact:true}).click()
  await expect.poll(()=>sent.length).toBe(1)
  expect(sent[0]).toMatchObject({text:'first\nsecond'})
})

test('phone links retain their full destination across wrapped rows',async({page},info)=>{
  test.skip(info.project.name!=='phone')
  const links=page.locator('.mobile-terminal-text a')
  await expect(links.first()).toHaveAttribute('href','https://example.org/very/long/resource')
  expect(await page.evaluate(()=>(window as any).fixture.text())).toContain('curl --header    "한글 test" https://example.org/very/long/resource')
  expect(await page.evaluate(()=>(window as any).fixture.columns())).toBe('100')
})

test('phone table borders align across font sizes and rotation with no second wrapping',async({page},info)=>{
  test.skip(info.project.name!=='phone')
  await page.evaluate(()=>document.fonts.ready)
  for(const width of [390,430,844])for(const fontSize of [12,13])for(const wide of [false,true]){
    await page.setViewportSize({width,height:844})
    await page.evaluate(({wide,fontSize})=>(window as any).fixture.table(wide,fontSize),{wide,fontSize})
    await expect(page.locator('.mobile-terminal-grid')).toHaveCount(6)
    const layout=await page.evaluate(()=>{
      const root=document.querySelector<HTMLElement>('.mobile-output-scroll')!
      const grids=[...root.querySelectorAll<HTMLElement>('.mobile-terminal-grid')]
      return {overflow:root.scrollWidth-root.clientWidth,right:root.getBoundingClientRect().right,
        rows:grids.map(grid=>({right:grid.getBoundingClientRect().right,top:grid.getBoundingClientRect().top,
          joints:[...grid.querySelectorAll<HTMLElement>('.mobile-terminal-grid-run > span')]
            .filter(cell=>/^[│┌┬┐└┴┘]$/.test(cell.textContent!)).map(cell=>cell.getBoundingClientRect().left)}))}
    })
    expect(layout.overflow).toBeLessThanOrEqual(1)
    for(const [i,row] of layout.rows.entries()){
      expect(row.right).toBeLessThanOrEqual(layout.right+.1)
      expect(row.joints).toHaveLength(3)
      row.joints.forEach((x,j)=>expect(Math.abs(x-layout.rows[0].joints[j])).toBeLessThan(.1))
      if(i)expect(Math.abs(row.top-layout.rows[i-1].top-fontSize)).toBeLessThan(.1)
    }
  }
})
