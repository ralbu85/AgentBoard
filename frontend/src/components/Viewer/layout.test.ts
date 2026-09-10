import {beforeEach,expect,it} from 'vitest'
import {leaves,mapTree,moveTab,newLeaf,readLayout,saveLayout,syncTree,type SplitNode} from './layout'
beforeEach(()=>localStorage.clear())
it('splits two tabs and restores direction, ratio and each pane selection',()=>{
  const original=newLeaf(['terminal:1','file.pdf'],'file.pdf')
  let tree=moveTab(original,'file.pdf',original.id,'right') as SplitNode
  expect(tree.direction).toBe('horizontal')
  tree={...tree,ratio:.65}
  saveLayout('a',tree)
  const restored=readLayout('a',['terminal:1','file.pdf'],'file.pdf') as SplitNode
  expect(restored.ratio).toBe(.65)
  expect(leaves(restored).map(p=>p.activeTabId)).toEqual(['terminal:1','file.pdf'])
  expect(readLayout('b',['other'],'other').type).toBe('leaf')
})
it('moves tabs between panes and collapses empty splits without losing other tabs',()=>{
  const original=newLeaf(['a','b','c'],'a')
  const split=moveTab(original,'b',original.id,'bottom')
  const target=leaves(split).find(p=>p.tabIds.includes('a'))!
  const merged=moveTab(split,'b',target.id,'center')
  expect(merged.type).toBe('leaf')
  expect(leaves(merged).flatMap(p=>p.tabIds).sort()).toEqual(['a','b','c'])
})
it('adds new files to the focused pane and preserves order while pruning closed tabs',()=>{
  const original=newLeaf(['a','b'],'a')
  const split=moveTab(original,'b',original.id,'right')
  const right=leaves(split).find(p=>p.tabIds.includes('b'))!
  const next=syncTree(split,['a','b','c'],'c',right.id)
  expect(leaves(next).find(p=>p.id===right.id)?.tabIds).toEqual(['b','c'])
  const closed=syncTree(next,['b','c'],'c',right.id)
  expect(closed.type).toBe('leaf')
})
it('rejects malformed persisted layouts',()=>{
  localStorage.setItem('agentboard.layout.a',JSON.stringify({type:'split',id:'bad',ratio:9,children:[]}))
  expect(readLayout('a',['a'],'a').type).toBe('leaf')
})
