export function guideBlocks(source) {
  const lines=source.split('\n'), blocks=[]
  for(let i=0;i<lines.length;) {
    const line=lines[i]
    if(!line.trim()){i++;continue}
    if(line.startsWith('```')) {
      const code=[];i++
      while(i<lines.length && !lines[i].startsWith('```'))code.push(lines[i++])
      blocks.push({type:'code',text:code.join('\n')});i++;continue
    }
    const heading=line.match(/^(#{1,3}) (.+)$/)
    if(heading){blocks.push({type:'heading',level:heading[1].length,text:heading[2]});i++;continue}
    if(line.startsWith('|')) {
      const rows=[]
      while(i<lines.length && lines[i].startsWith('|')) {
        const cells=lines[i++].split('|').slice(1,-1).map(s=>s.trim())
        if(!cells.every(s=>/^:?-+:?$/.test(s)))rows.push(cells)
      }
      blocks.push({type:'table',rows});continue
    }
    const item=line.match(/^(?:- |\d+\. )(.+)$/)
    blocks.push({type:item?'item':'paragraph',text:item?item[1]:line});i++
  }
  return blocks
}
export function guideText(text) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map(value=>({type:value.startsWith('`')?'code':value.startsWith('**')?'strong':'span',text:value.startsWith('`')?value.slice(1,-1):value.startsWith('**')?value.slice(2,-2):value}))
}
