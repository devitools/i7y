export interface IncidentSource {
  id:string
  name:string
  generation:number
  organizations:{id:string;name:string;role?:string}[]
  send:(path:string,query?:Record<string,unknown>,organization?:string)=>Promise<any>
}
export interface IncidentOrigin {connection_id:string;connection_name:string;organization:string;organization_name:string;organization_role?:string;source_generation:number;source_key:string}
const base='/api/i7y/alerts/v1'
export function incidentKey(row:{connection_id:string;organization:string;id?:string;incident_id?:string}) {return JSON.stringify([row.connection_id,row.organization,row.id || row.incident_id])}
export function incidentHref(row:{connection_id:string;organization:string;id?:string;incident_id?:string}) {
  return '#/incidents/'+encodeURIComponent(row.id || row.incident_id || '')+'?'+new URLSearchParams({connection:row.connection_id,organization:row.organization})
}
export function compareIncidents(a:any,b:any) {
  for(const key of ['opened_at','created','id']) {const compared=String(b[key] || '').localeCompare(String(a[key] || ''));if(compared)return compared}
  return incidentKey(a).localeCompare(incidentKey(b))
}
function origin(source:IncidentSource,row:any,organization?:string):IncidentOrigin {
  const id=row.organization || organization || ''
  const org=source.organizations.find(item=>item.id===id)
  if(!org)throw new Error('Incident organization unavailable')
  return {connection_id:source.id,connection_name:source.name,organization:id,organization_name:row.organization_name || org.name,organization_role:row.organization_role || org.role,source_generation:source.generation,source_key:JSON.stringify([source.id,source.generation,organization || '*'])}
}
export function sourceFingerprint(sources:IncidentSource[]) {return JSON.stringify(sources.map(source=>[source.id,source.generation,source.organizations.map(org=>[org.id,org.name,org.role]).sort((a,b)=>a[0].localeCompare(b[0]))]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))}
interface Stream {source:IncidentSource;organization?:string;items:any[];page:number;total:number;pages:number;failed:boolean}
export function createIncidentInbox() {
  let key='',streams:Stream[]=[],merged:any[]=[],seen=new Set<string>(),failures:string[]=[]
  let pending:Promise<any>=Promise.resolve(),revision=0
  function reset(){revision++;key='';streams=[];merged=[];seen.clear();failures=[]}
  async function first(source:IncidentSource,query:Record<string,unknown>,version:number):Promise<Stream[]> {
    const load=async(organization?:string)=>{
      const result=await source.send(base+(organization?'/incidents':'/inbox'),{...query,page:1,perPage:100},organization)
      if(version!==revision)throw new Error('Inbox context changed')
      if(!Array.isArray(result.items))throw new Error('Invalid incident response')
      return {source,organization,items:result.items.map(row=>({...row,...origin(source,row,organization)})),page:1,total:result.totalItems,pages:result.totalPages,failed:false}
    }
    try {return [await load()]}
    catch(error:any) {
      if(error.status!==404)throw error
      const results=await Promise.allSettled(source.organizations.map(org=>load(org.id)))
      const healthy:Stream[]=[]
      results.forEach(result=>{if(result.status==='fulfilled')healthy.push(result.value);else failures.push(source.id)})
      return healthy
    }
  }
  async function next(stream:Stream,query:Record<string,unknown>,version:number) {
    if(stream.failed || stream.page>=stream.pages || stream.items.length)return
    try {
      const page=stream.page+1
      const result=await stream.source.send(base+(stream.organization?'/incidents':'/inbox'),{...query,page,perPage:100},stream.organization)
      if(version!==revision)throw new Error('Inbox context changed')
      stream.items=result.items.map(row=>({...row,...origin(stream.source,row,stream.organization)}));stream.page=page;stream.pages=result.totalPages;stream.total=result.totalItems
    } catch {if(version===revision){stream.failed=true;failures.push(stream.source.id)}}
  }
  async function list(sources:IncidentSource[],query:Record<string,unknown>={}) {
    const {page=1,perPage=10,...filters}=query
    const nextKey=JSON.stringify([sourceFingerprint(sources),filters])
    if(key!==nextKey){reset();key=nextKey}
    const version=revision
    if(!streams.length && !merged.length) {
      const results=await Promise.allSettled(sources.map(source=>first(source,filters,version)))
      if(version!==revision)throw new Error('Inbox context changed')
      results.forEach((result,index)=>{if(result.status==='fulfilled')streams.push(...result.value);else failures.push(sources[index].id)})
    }
    const end=Number(page)*Number(perPage)
    while(merged.length<end) {
      await Promise.all(streams.map(stream=>next(stream,filters,version)))
      if(version!==revision)throw new Error('Inbox context changed')
      const available=streams.filter(stream=>stream.items.length).sort((a,b)=>compareIncidents(a.items[0],b.items[0]))
      if(!available.length)break
      const row=available[0].items.shift(),id=incidentKey(row)
      if(!seen.has(id)){seen.add(id);merged.push({...row,inbox_key:id})}
    }
    const totalItems=streams.reduce((sum,stream)=>sum+stream.total,0)
    return {items:merged.slice(end-Number(perPage),end),totalItems,totalPages:Math.ceil(totalItems/Number(perPage)),failures:[...new Set(failures)]}
  }
  return {reset,list:(sources:IncidentSource[],query:Record<string,unknown>={})=>{const request=pending.catch(()=>{}).then(()=>list(sources,query));pending=request;return request}}
}
interface NoticeStream {source:IncidentSource;organization?:string;cursor:string;initial:boolean;summarized:boolean;openCount:number;failed:boolean}
export function createIncidentNotificationInbox() {
  const streams=new Map<string,NoticeStream>(),modes=new Map<string,'inbox'|'legacy'>()
  let generation=0
  function reset(){generation++;streams.clear();modes.clear()}
  async function poll(sources:IncidentSource[],options:{deferCommit?:boolean}={}) {
    const version=++generation,active=new Set<string>(),items:any[]=[],failures:string[]=[]
    const stagedStreams=new Map([...streams].map(([id,stream])=>[id,{...stream}])),stagedModes=new Map(modes)
    let initialCount=0
    const key=(source:IncidentSource,organization?:string)=>JSON.stringify([source.id,source.generation,organization || '*'])
    async function load(source:IncidentSource,organization?:string) {
      const id=key(source,organization);active.add(id)
      const stream=stagedStreams.get(id) || {source,organization,cursor:'0',initial:true,summarized:false,openCount:0,failed:false}
      stagedStreams.set(id,stream)
      try {
        const result=await source.send(base+(organization?'/notification-events':'/inbox/notification-events'),{cursor:stream.cursor,limit:100},organization)
        if(version!==generation)return
        if(!Array.isArray(result.items))throw new Error('Invalid notification response')
        const initial=stream.initial
        for(const notice of result.items)if(BigInt(notice.sequence)>BigInt(stream.cursor) && !initial)items.push({...notice,...origin(source,notice,organization),notice_key:JSON.stringify([source.id,notice.organization || organization,notice.incident_id])})
        stream.cursor=String(result.cursor || stream.cursor);stream.openCount=result.open_count;stream.failed=false
        if(initial && !stream.summarized){initialCount+=result.open_count;stream.summarized=true}
        stream.initial=initial && result.items.length>=100
      } catch(error:any) {if(version!==generation)return;stream.failed=true;if(error.status===404 && !organization)throw error;failures.push(source.id)}
    }
    await Promise.all(sources.map(async source=>{
      const identity=key(source)
      if(stagedModes.get(identity)==='legacy'){await Promise.all(source.organizations.map(org=>load(source,org.id)));return}
      try {await load(source);if(version===generation)stagedModes.set(identity,'inbox')}
      catch {if(version!==generation)return;stagedStreams.delete(identity);active.delete(identity);stagedModes.set(identity,'legacy');await Promise.all(source.organizations.map(org=>load(source,org.id)))}
    }))
    if(version!==generation)throw new Error('Inbox context changed')
    for(const id of stagedStreams.keys())if(!active.has(id))stagedStreams.delete(id)
    for(const id of stagedModes.keys())if(!sources.some(source=>key(source)===id))stagedModes.delete(id)
    let committed=false
    function commit() {
      if(committed)return
      if(version!==generation)throw new Error('Inbox context changed')
      streams.clear();for(const [id,stream] of stagedStreams)streams.set(id,stream)
      modes.clear();for(const [id,mode] of stagedModes)modes.set(id,mode)
      committed=true
    }
    const result={items,initialCount,open_count:[...stagedStreams.values()].reduce((sum,stream)=>sum+stream.openCount,0),failures:[...new Set(failures)],commit}
    if(!options.deferCommit)commit()
    return result
  }
  return {poll,reset}
}
