export function NotebookCellInsert({index,disabled,onInsert}:{
  index:number;disabled:boolean;onInsert:(kind:string,index:number)=>void
}){
  return <select className="nb-cell-insert-menu" aria-label={`셀 ${index+1} 주변에 셀 추가`} title="위·아래에 셀 추가" disabled={disabled} value="" onChange={event=>{
    const [position,kind]=event.target.value.split(':')
    onInsert(kind,index+(position==='below'?1:0))
  }}>
    <option value="" disabled>＋</option>
    <option value="above:code">위에 코드 셀</option>
    <option value="above:markdown">위에 마크다운 셀</option>
    <option value="below:code">아래에 코드 셀</option>
    <option value="below:markdown">아래에 마크다운 셀</option>
  </select>
}
