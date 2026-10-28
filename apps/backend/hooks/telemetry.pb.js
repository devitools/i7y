routerAdd('GET','/api/i7y/agents',(e) => {
  e.response.header().set('Cache-Control','no-store')
  return e.json(200,{items:e.app.findAllRecords('server_agents').filter(r=>{const lib=require(__hooks+'/lib/organizations.js');const org=lib.organization(e.app,r);const selected=e.request.header.get('X-I7y-Organization');return (!selected||selected===org)&&!!lib.role(e.app,e.auth,org)}).map(r=>({id:r.id,server:r.getString('server'),prefix:r.getString('prefix'),created:r.getString('created')}))})
}, $apis.requireAuth('users'))

routerAdd('POST','/api/i7y/agents',(e) => {
  const server=String(e.requestInfo().body.server || '')
  const target=e.app.findRecordById('servers',server)
  const lib=require(__hooks+'/lib/organizations.js');lib.requireRole(e,lib.organization(e.app,target),true)
  const token='i7ya_'+$security.randomString(64)
  e.app.runInTransaction(app=>{
    for (const old of app.findRecordsByFilter('server_agents','server={:server}','',0,0,{server})) app.delete(old)
    const r=new Record(app.findCollectionByNameOrId('server_agents'))
    r.set('server',server); r.set('token_hash',$security.sha256(token)); r.set('prefix',token.slice(0,13)); app.save(r)
  })
  e.response.header().set('Cache-Control','no-store')
  return e.json(201,{server,token})
}, $apis.requireAuth('users'))

routerAdd('DELETE','/api/i7y/agents/{id}',e=>{
  const target=e.app.findRecordById('server_agents',e.request.pathValue('id'))
  const lib=require(__hooks+'/lib/organizations.js');lib.requireRole(e,lib.organization(e.app,target),true)
  e.app.delete(target)
  return e.noContent(204)
}, $apis.requireAuth('users'))

routerAdd('POST','/api/i7y/telemetry/v1/snapshots',e=>{
  const token=e.request.header.get('Authorization').replace(/^Bearer\s+/i,'').trim()
  if (!/^i7ya_[A-Za-z0-9]{64}$/.test(token)) throw new UnauthorizedError('Invalid agent credential')
  let agent
  try { agent=e.app.findFirstRecordByFilter('server_agents','token_hash={:hash}',{hash:$security.sha256(token)}) }
  catch (_) { throw new UnauthorizedError('Invalid agent credential') }
  const lib=require(__hooks+'/lib/telemetry.js')
  const body=e.requestInfo().body
  try { lib.validate(body) } catch (err) { throw new BadRequestError(String(err.message)) }
  const server=agent.getString('server')
  let duplicate=false
  e.app.runInTransaction(app=>{
    const existing=app.findRecordsByFilter('telemetry_samples','server={:server} && sample_id={:sample}','',1,0,{server,sample:body.sample_id})
    if (existing.length) { duplicate=true; return }
    const r=new Record(app.findCollectionByNameOrId('telemetry_samples'))
    r.set('server',server); r.set('sample_id',body.sample_id); r.set('observed_at',body.observed_at); r.set('received_at',new Date().toISOString()); r.set('payload',body); app.save(r)
    lib.reconcile(app,server,body)
  })
  e.response.header().set('Cache-Control','no-store')
  return e.json(200,{accepted:true,duplicate})
}, $apis.bodyLimit(4 * 1024 * 1024))

cronAdd('telemetry-retention','17 3 * * *',()=>{
  const cutoff=new Date(Date.now()-30*86400000).toISOString()
  $app.db().newQuery('DELETE FROM telemetry_samples WHERE observed_at < {:cutoff}').bind({cutoff}).execute()
})

routerAdd('GET','/api/i7y/telemetry/v1/config',e=>{
  const token=e.request.header.get('Authorization').replace(/^Bearer\s+/i,'').trim()
  if(!/^i7ya_[A-Za-z0-9]{64}$/.test(token)) throw new UnauthorizedError('Invalid agent credential')
  let agent
  try{agent=e.app.findFirstRecordByFilter('server_agents','token_hash={:hash}',{hash:$security.sha256(token)})}catch(_){throw new UnauthorizedError('Invalid agent credential')}
  const projects=e.app.findRecordsByFilter('projects','server={:server}','',0,0,{server:agent.getString('server')})
  const containers=e.app.findRecordsByFilter('containers','project.server={:server}','',0,0,{server:agent.getString('server')})
  e.response.header().set('Cache-Control','no-store')
  return e.json(200,{projects:projects.map(p=>({key:p.id,name:p.getString('name'),path:p.getString('path')})),containers:containers.map(c=>{const p=projects.find(p=>p.id===c.getString('project'));return {name:c.getString('name'),path:p.getString('path'),project_name:p.getString('name')}})})
})
