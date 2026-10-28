export function createQueryCache({ttl=30000,maxEntries=200,now=()=>Date.now()}={}) {
  const entries = new Map()
  let generation = 0
  return {
    get(key, fetcher, {force=false}={}) {
      const entry=entries.get(key)
      if (!force && entry && (entry.pending || entry.expires>now())) return entry.promise
      const version=generation
      const next={pending:true,expires:0}
      next.promise=Promise.resolve().then(fetcher).then(value=>{
        if (generation===version && entries.get(key)===next) {next.pending=false;next.expires=now()+ttl}
        return value
      }).catch(error=>{if(entries.get(key)===next)entries.delete(key);throw error})
      if(entries.size>=maxEntries) {
        for(const [stored,value] of entries) if(!value.pending&&value.expires<=now())entries.delete(stored)
        if(entries.size>=maxEntries)entries.delete(entries.keys().next().value)
      }
      entries.set(key,next)
      return next.promise
    },
    clear() {generation++;entries.clear()},
  }
}
