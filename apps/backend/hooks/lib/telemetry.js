function validate(b) {
  if (b.version!==1 || typeof b.sample_id!=='string' || !/^[a-zA-Z0-9-]{16,80}$/.test(b.sample_id)) throw new Error('Invalid version or sample ID')
  const time=Date.parse(b.observed_at)
  if (!Number.isFinite(time) || time>Date.now()+300000 || time<Date.now()-30*86400000) throw new Error('Invalid observation time')
  if (!b.host || typeof b.host!=='object' || Array.isArray(b.host) || typeof b.docker_complete!=='boolean' || typeof b.discovery_complete!=='boolean') throw new Error('Invalid collection status')
  if (!Array.isArray(b.projects) || !Array.isArray(b.containers) || !Array.isArray(b.errors) || b.projects.length>2000 || b.containers.length>10000) throw new Error('Invalid inventory')
  if (b.collection_mode!==undefined && !['docker','host'].includes(b.collection_mode)) throw new Error('Invalid collection mode')
  if (b.collection_mode==='host' && (b.projects.length || b.containers.length || b.docker_complete || b.discovery_complete)) throw new Error('Host-only report cannot reconcile inventory')
  const names=new Set(), keys=new Set()
  for (const p of b.projects) {
    if (!p || typeof p.key!=='string' || !p.key || p.key.length>1024 || keys.has(p.key) || typeof p.name!=='string' || p.name.length>256 || typeof p.path!=='string' || p.path.length>1024) throw new Error('Invalid or duplicate project')
    keys.add(p.key)
  }
  for (const c of b.containers) {
    if (!c || typeof c.name!=='string' || !c.name || c.name.length>256 || names.has(c.name) || !keys.has(c.project_key) || typeof c.image!=='string' || c.image.length>1024 || typeof c.state!=='string' || !['created','running','paused','restarting','removing','exited','dead'].includes(c.state)) throw new Error('Invalid or duplicate container')
    names.add(c.name)
  }
}
function current(r) { try { return JSON.parse(r.getString('telemetry')) || {} } catch (_) { return {} } }
function reconcile(app,serverId,b) {
  const server=app.findRecordById('servers',serverId)
  const previous=current(server)
  if (previous.observed_at && Date.parse(previous.observed_at)>=Date.parse(b.observed_at)) return
  if (b.collection_mode==='host') {
    server.set('telemetry',{state:b.errors.length?'degraded':'healthy',collection_mode:'host',observed_at:b.observed_at,host:b.host,agent_version:b.agent_version,errors:b.errors,warnings:[],docker_complete:false,discovery_complete:false})
    server.set('last_seen',b.observed_at);app.save(server);return
  }
  const projects=app.findRecordsByFilter('projects','server={:server}','',0,0,{server:serverId})
  const containers=app.findRecordsByFilter('containers','project.server={:server}','',0,0,{server:serverId})
  const seenP=new Set(),seenC=new Set(),map={},warnings=[]
  function saveCurrent(r,data) { r.set('telemetry',{...data,observed_at:b.observed_at}); if(data.state!=='missing') r.set('last_seen',b.observed_at); app.save(r) }
  function create(table,values) { const r=new Record(app.findCollectionByNameOrId(table)); for(const k in values) r.set(k,values[k]); app.save(r); return r }
  for(const p of b.projects) {
    const matches=projects.filter(r=>r.id===p.key || (p.path && r.getString('path')===p.path) || (current(r)).discovery_key===p.key)
    let row=matches.length===1?matches[0]:null
    if(matches.length>1) {warnings.push('Ambiguous project: '+p.name);continue}
    if(!row) {
      const byName=projects.filter(r=>r.getString('name')===p.name && (!r.getString('path') || !p.path))
      if(byName.length>1) {warnings.push('Ambiguous project: '+p.name);continue}
      row=byName[0] || create('projects',{server:serverId,name:p.name,path:p.path})
      if(!projects.some(r=>r.id===row.id)) projects.push(row)
    }
    map[p.key]=row;seenP.add(row.id)
    row.set('name',p.name); if(p.path) row.set('path',p.path)
    saveCurrent(row,{state:'unknown',discovery_key:p.key})
  }
  for(const c of b.containers) {
    const parent=map[c.project_key]
    if(!parent) continue
    const matches=containers.filter(r=>r.getString('name')===c.name)
    if(matches.length>1) {warnings.push('Ambiguous container: '+c.name); for(const match of matches){seenC.add(match.id);seenP.add(match.getString('project'))} continue}
    let row=matches[0]
    if(!row) {row=create('containers',{project:parent.id,name:c.name,image:c.image});containers.push(row)}
    else if(row.getString('project')!==parent.id) {
      const existingParent=projects.find(p=>p.id===row.getString('project'))
      if(existingParent) seenP.add(existingParent.id)
      if(c.project_key!=='unassigned') warnings.push('Container association differs: '+c.name)
    }
    row.set('image',c.image)
    const {project_key,...values}=c
    const previousContainer=current(row)
    if(b.metrics_complete===false && c.state==='running' && previousContainer.docker_id===c.docker_id) {
      for(const field of ['cpu_percent','memory_bytes','memory_limit_bytes']) if(field in previousContainer) values[field]=previousContainer[field]
    }
    saveCurrent(row,values);seenC.add(row.id)
  }
  if(b.docker_complete) for(const c of containers) if(!seenC.has(c.id)) saveCurrent(c,{state:'missing'})
  for(const p of projects) {
    const children=containers.filter(c=>c.getString('project')===p.id).map(c=>current(c))
    let state='unknown'
    if(children.length && b.docker_complete) {
      const healthy=children.filter(c=>c.state==='running' && c.health!=='unhealthy' && c.health!=='starting').length
      state=healthy===children.length?'healthy':healthy>0?'degraded':children.every(c=>['exited','dead','created','missing'].includes(c.state))?'stopped':'degraded'
    }
    if(!seenP.has(p.id) && b.docker_complete && b.discovery_complete) state='missing'
    saveCurrent(p,{...(current(p)),state})
  }
  if(b.docker_complete) server.set('inventory_known',true)
  const degraded=(b.errors.length || warnings.length || !b.docker_complete || !b.discovery_complete || projects.some(p=>['degraded','stopped','missing'].includes((current(p)).state)))
  saveCurrent(server,{state:degraded?'degraded':'healthy',host:b.host,agent_version:b.agent_version,errors:b.errors,warnings,docker_complete:b.docker_complete,discovery_complete:b.discovery_complete})
}
module.exports={validate,reconcile}
