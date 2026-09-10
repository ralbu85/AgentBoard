export interface PaneNode {type:'leaf'; id:string; tabIds:string[]; activeTabId:string|null}
export interface SplitNode {type:'split'; id:string; direction:'horizontal'|'vertical'; ratio:number; children:[TreeNode,TreeNode]}
export type TreeNode = PaneNode | SplitNode
export type DropZone = 'left'|'right'|'top'|'bottom'|'center'
export const newLeaf = (tabIds:string[], activeTabId:string|null=tabIds[0]||null):PaneNode => ({type:'leaf',id:crypto.randomUUID(),tabIds,activeTabId})
export const leaves = (tree:TreeNode):PaneNode[] => tree.type==='leaf' ? [tree] : tree.children.flatMap(leaves)
export function mapTree(tree:TreeNode, fn:(node:TreeNode)=>TreeNode):TreeNode {
  const next=tree.type==='split' ? {...tree,children:tree.children.map(child=>mapTree(child,fn)) as [TreeNode,TreeNode]} : tree
  return fn(next)
}
function prune(tree:TreeNode):TreeNode|null {
  if(tree.type==='leaf') return tree.tabIds.length ? tree : null
  const [a,b]=tree.children.map(prune)
  return a&&b ? {...tree,children:[a,b]} : a||b
}
export function syncTree(tree:TreeNode, ids:string[], active:string|null, focused:string):TreeNode {
  const seen=new Set<string>()
  let next=mapTree(tree,n=>{
    if(n.type==='split')return n
    const tabIds=ids.filter(id=>n.tabIds.includes(id)&&!seen.has(id))
    tabIds.forEach(id=>seen.add(id))
    return {...n,tabIds,activeTabId:tabIds.includes(active||'') ? active : tabIds.includes(n.activeTabId||'') ? n.activeTabId : tabIds[0]||null}
  })
  const target=leaves(next).find(p=>p.id===focused)||leaves(next)[0]
  const missing=ids.filter(id=>!seen.has(id))
  next=mapTree(next,n=>n.type==='leaf'&&n.id===target.id ? {...n,tabIds:[...n.tabIds,...missing],activeTabId:missing.includes(active||'')?active:n.activeTabId||missing[0]||null} : n)
  return prune(next)||newLeaf([])
}
export function moveTab(tree:TreeNode, tab:string, targetId:string, zone:DropZone):TreeNode {
  const target=leaves(tree).find(p=>p.id===targetId)
  if(!target||!leaves(tree).some(p=>p.tabIds.includes(tab)))return tree
  if(target.tabIds.length===1&&target.tabIds[0]===tab&&zone!=='center')return tree
  let next=mapTree(tree,n=>n.type==='leaf'?{...n,tabIds:n.tabIds.filter(id=>id!==tab),activeTabId:n.activeTabId===tab?[...n.tabIds].reverse().find(id=>id!==tab)||null:n.activeTabId}:n)
  next=mapTree(next,n=>{
    if(n.type!=='leaf'||n.id!==targetId)return n
    if(zone==='center')return {...n,tabIds:[...n.tabIds,tab],activeTabId:tab}
    const added=newLeaf([tab]), first=zone==='left'||zone==='top'
    return {type:'split',id:crypto.randomUUID(),direction:zone==='left'||zone==='right'?'horizontal':'vertical',ratio:.5,children:first?[added,n]:[n,added]}
  })
  return prune(next)||newLeaf([tab])
}
function validTree(value:unknown, depth=0):value is TreeNode {
  if(!value||typeof value!=='object'||depth>12)return false
  const n=value as TreeNode
  if(typeof n.id!=='string')return false
  if(n.type==='leaf')return Array.isArray(n.tabIds)&&n.tabIds.every(id=>typeof id==='string')&&(typeof n.activeTabId==='string'||n.activeTabId===null)
  return n.type==='split'&&['horizontal','vertical'].includes(n.direction)&&Number.isFinite(n.ratio)&&n.ratio>=.15&&n.ratio<=.85&&Array.isArray(n.children)&&n.children.length===2&&n.children.every(child=>validTree(child,depth+1))
}
export function readLayout(key:string, ids:string[], active:string|null):TreeNode {
  try {const saved=JSON.parse(localStorage.getItem('agentboard.layout.'+key)||'null');if(validTree(saved))return syncTree(saved,ids,active,leaves(saved)[0].id)}catch{}
  return newLeaf(ids,active)
}
export function saveLayout(key:string, tree:TreeNode) {
  try {localStorage.setItem('agentboard.layout.'+key,JSON.stringify(tree))}catch{}
}
