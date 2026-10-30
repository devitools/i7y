function fail(status,message) { throw new ApiError(status,message) }
function object(value) { return value && typeof value==='object' && !Array.isArray(value) }
function text(value,name,max=240,required=false) {
  if(value===undefined || value===null)value=''
  if(typeof value!=='string' || value.length>max || (required && !value.trim()))fail(400,'Invalid '+name)
  return value.trim()
}
function json(record,field,fallback=null) {
  try { const value=record.getString(field);return value?JSON.parse(value):fallback } catch(_){return fallback}
}
function canonical(value) {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
  if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}'
  return JSON.stringify(value)
}
function mapped(fn) {
  try{return fn()}catch(err){if(err.status || err.statusCode)throw err;fail(Number(err.code)===409?409:400,String(err.message||'Invalid request'))}
}
function find(app,collection,id) {
  try{return app.findRecordById(collection,id)}catch(_){fail(404,'Resource not found')}
}
function recordForOrg(app,collection,id,org) {
  const record=find(app,collection,id)
  if(record.getString('organization')!==org)fail(404,'Resource not found')
  return record
}
function permission(e,app,capability,write=false,sessionOnly=false) {
  const org=text(e.request.header.get('X-I7y-Organization'),'organization',15,true)
  if(!e.auth || e.auth.collection().name!=='users')fail(401,'Sign in required')
  let user
  try{user=app.findRecordById('users',e.auth.id)}catch(_){fail(401,'Sign in required')}
  const token=e.get('i7yApiToken')
  if(token) {
    if(sessionOnly)fail(403,'A user session is required')
    let current
    try{current=app.findRecordById('api_tokens',token.id)}catch(_){fail(401,'Invalid API token')}
    const bearer=e.request.header.get('Authorization').replace(/^Bearer\s+/i,'').trim()
    if(current.getString('user')!==user.id || current.getString('organization')!==org || current.getString('token_hash')!==$security.sha256(bearer) || Date.parse(current.getString('expires_at').replace(' ','T'))<=Date.now())fail(401,'Invalid API token')
    const caps=require(__hooks+'/lib/alert-capabilities.js').capabilities(current)
    if(!caps.includes(capability))fail(403,'API token permission denied')
  }
  const lib=require(__hooks+'/lib/organizations.js')
  const role=lib.role(app,user,org)
  if(!role || (write && !['editor','admin'].includes(role)))fail(403,'Organization access denied')
  find(app,'organizations',org)
  return {org,user,producer:token?'token:'+token.id:'user:'+user.id}
}
function inventoryContext(app,type,id,org) {
  if(!['workspace','server','container'].includes(type))fail(400,'Invalid inventory target type')
  const record=find(app,{workspace:'workspaces',server:'servers',container:'containers'}[type],text(id,'target ID',15,true))
  let workspace,server,container
  if(type==='workspace')workspace=record
  if(type==='server'){server=record;workspace=find(app,'workspaces',server.getString('workspace'))}
  if(type==='container'){container=record;const project=find(app,'projects',record.getString('project'));server=find(app,'servers',project.getString('server'));workspace=find(app,'workspaces',server.getString('workspace'))}
  if(workspace.getString('organization')!==org)fail(404,'Resource not found')
  return {resource_type:type,resource_id:record.id,resource_name:record.getString(type==='workspace'?'login':'name').slice(0,512),workspace_id:workspace.id,server_id:server?server.id:'',container_id:container?container.id:''}
}
function ruleBody(app,org,body) {
  if(!object(body))fail(400,'Invalid rule')
  const normalized=mapped(()=>require(__hooks+'/lib/alerts.js').normalizeRule(body))
  inventoryContext(app,normalized.scope_type,normalized.scope_id,org)
  return normalized
}
function incidentBody(app,org,body) {
  if(!object(body))fail(400,'Invalid incident')
  const out={title:text(body.title,'title',240,true),severity:severity(body.severity),evidence:evidence(body.evidence),reminder_seconds:interval(body.reminder_seconds)}
  if(body.resource_id || body.resource_type)Object.assign(out,inventoryContext(app,body.resource_type,body.resource_id,org))
  else if(body.workspace_id)Object.assign(out,inventoryContext(app,'workspace',body.workspace_id,org))
  else out.resource_name=text(body.resource_name,'resource name',512)
  for(const key of ['organization','integration','source_key','external_id'])if(body[key]!==undefined)fail(400,'Use an integration for source identities')
  return out
}
function severity(value) {
  if(value===undefined || value==='')return 'warning'
  if(!['info','warning','critical'].includes(value))fail(400,'Invalid severity')
  return value
}
function interval(value) {
  if(value===undefined)return 900
  if(typeof value!=='number' || !Number.isInteger(value) || value<60 || value>604800)fail(400,'Reminder interval must be 60 to 604800 seconds')
  return value
}
function evidence(value) {
  if(value===undefined)return {}
  if(!object(value) || JSON.stringify(value).length>131072)fail(400,'Invalid evidence')
  return value
}
function version(body,record) {
  if(!object(body) || !Number.isInteger(body.version) || body.version<1)fail(400,'Provide the incident version')
  if(body.version!==record.getInt('version'))fail(409,'Incident changed; reload before acting')
}
function claimDeadline(value) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value) || !Number.isFinite(Date.parse(value)))fail(400,'Provide a UTC claim deadline')
  return value
}
const fields={
  alert_rules:{text:['key','name','severity','scope_type','scope_id','target_type','activated_at'],bool:['enabled','archived'],number:['duration_seconds','reminder_seconds','revision','edit_version'],json:['condition']},
  alert_integrations:{text:['name','kind','workspace_id','prefix','last_received_at'],bool:['enabled'],number:['reminder_seconds'],json:['last_event']},
  incidents:{text:['rule','integration','external_id','origin','title','severity','status','resource_type','resource_id','resource_name','workspace_id','server_id','container_id','opened_at','resolved_at','resolution_reason','assignee','claim_until','next_reminder_at'],number:['rule_revision','reminder_seconds','schedule_generation','version'],json:['evidence']},
  incident_events:{text:['incident','kind','actor','occurred_at'],json:['data']},
}
function dto(record,collection) {
  const spec=fields[collection||record.collection().name]
  const result={id:record.id,organization:record.getString('organization'),created:record.getString('created'),updated:record.getString('updated')}
  for(const key of spec.text||[])result[key]=record.getString(key)
  for(const key of spec.bool||[])result[key]=record.getBool(key)
  for(const key of spec.number||[])result[key]=record.getFloat(key)
  for(const key of spec.json||[])result[key]=json(record,key,{})
  return result
}
function query(e) {return e.request.url.query()}
function positiveInteger(value,fallback,max) {
  if(!value)return fallback
  if(!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value)<1)fail(400,'Invalid pagination')
  return Math.min(Number(value),max)
}
function listing(e,app,collection,org) {
  const q=query(e),page=positiveInteger(q.get('page'),1,1000000),perPage=positiveInteger(q.get('perPage'),50,100)
  const clauses=['organization={:org}'],params={org}
  if(collection==='incidents') {
    const status=q.get('status')||'open'
    if(!['open','resolved','all'].includes(status))fail(400,'Invalid status')
    if(status!=='all'){clauses.push('status={:status}');params.status=status}
    const allowed={severity:['info','warning','critical'],origin:['rule','api','gcp'],resource_type:null,resource_id:null,workspace_id:null,server_id:null,assignee:null}
    for(const key in allowed){const value=q.get(key);if(value){if(value.length>240 || (allowed[key] && !allowed[key].includes(value)))fail(400,'Invalid filter');clauses.push(key+'={:'+key+'}');params[key]=value}}
    if(q.get('overdue')){if(!['true','false'].includes(q.get('overdue')))fail(400,'Invalid overdue filter');if(q.get('overdue')==='true'){clauses.push('status="open" && assignee!="" && claim_until!="" && claim_until<={:now}');params.now=new Date().toISOString().replace('T',' ')}}
    const search=q.get('search')
    if(search){text(search,'search',240);clauses.push('(title ~ {:search} || resource_name ~ {:search})');params.search=search}
  }else if(collection==='alert_rules')clauses.push('archived=false')
  const filter=clauses.join(' && ')
  const count=app.findRecordsByFilter(collection,filter,'',0,0,params).length
  const records=app.findRecordsByFilter(collection,filter,collection==='incidents'?'-opened_at,-created':'-created',perPage,(page-1)*perPage,params)
  return {items:records.map(r=>dto(r,collection)),page,perPage,totalItems:count,totalPages:Math.ceil(count/perPage)}
}
function receipt(app,org,producer,operation,key,body,action,required=false) {
  if(!key){if(required)fail(400,'Idempotency-Key is required');return action()}
  key=text(key,'Idempotency-Key',200,true)
  const hash=$security.sha256(canonical(body))
  const rows=app.findRecordsByFilter('alert_receipts','organization={:org} && producer={:producer} && operation={:operation} && key={:key}','',1,0,{org,producer,operation,key})
  if(rows.length){if(rows[0].getString('payload_hash')!==hash)fail(409,'Idempotency-Key was used for another payload');return json(rows[0],'result',{})}
  const result=action(),record=new Record(app.findCollectionByNameOrId('alert_receipts'))
  for(const [field,value] of Object.entries({organization:org,producer,operation,key,payload_hash:hash,result}))record.set(field,value)
  app.save(record)
  return result
}
function normalizeEvent(body) {
  if(!object(body))fail(400,'Invalid source event')
  if(!['open','closed'].includes(body.state))fail(400,'Invalid source state')
  return {external_id:text(body.external_id,'external identity',240,true),state:body.state,title:text(body.title,'title',240)||'External incident',severity:severity(body.severity),resource_type:text(body.resource_type,'resource type',64)||'external',resource_id:text(body.resource_id,'resource ID',240),resource_name:text(body.resource_name,'resource name',512),evidence:evidence(body.evidence)}
}
function normalizeGcp(body) {
  if(!object(body) || body.version!=='1.2' || !object(body.incident))fail(400,'Only Cloud Monitoring schema 1.2 is supported')
  const i=body.incident
  const suppliedSeverity=typeof i.severity==='string'?i.severity.toLowerCase():''
  const level={critical:'critical',error:'critical',warning:'warning',info:'info',informational:'info','no severity':'warning'}[suppliedSeverity]||'warning'
  const event={external_id:i.incident_id,state:i.state,title:typeof i.summary==='string'?i.summary.slice(0,240):typeof i.policy_name==='string'?i.policy_name.slice(0,240):'Google Cloud incident',severity:level,resource_type:i.resource&&typeof i.resource.type==='string'?i.resource.type:'external',resource_id:typeof i.resource_id==='string'?i.resource_id:'',resource_name:typeof i.resource_display_name==='string'?i.resource_display_name:typeof i.resource_name==='string'?i.resource_name:'',evidence:{}}
  for(const key of ['started_at','ended_at','observed_value','threshold_value','policy_name','condition_name','renotify','scoping_project_id','scoping_project_number','resource','metric','metadata','documentation'])if(i[key]!==undefined)event.evidence[key]=i[key]
  if(typeof i.url==='string' && /^https?:\/\//i.test(i.url))event.evidence.url=i.url
  return normalizeEvent(event)
}
function credential(e,app,kind) {
  const id=text(e.request.pathValue('id'),'integration ID',15,true)
  let secret=''
  const auth=e.request.header.get('Authorization')
  if(kind==='gcp'){
    e.response.header().set('WWW-Authenticate','Basic realm="i7y-gcp"')
    if(!/^Basic\s+/i.test(auth))fail(401,'Integration credential required')
    const basic=e.request.basicAuth()
    if(!basic[2] || basic[0]!==id)fail(401,'Invalid integration credential')
    secret=basic[1]
  }else{
    if(!/^Bearer\s+/i.test(auth))fail(401,'Integration credential required')
    secret=auth.replace(/^Bearer\s+/i,'').trim()
  }
  if(!/^i7yh_[A-Za-z0-9]{64}$/.test(secret))fail(401,'Invalid integration credential')
  let integration
  try{integration=app.findRecordById('alert_integrations',id)}catch(_){fail(401,'Invalid integration credential')}
  if(!integration.getBool('enabled') || integration.getString('kind')!==kind || integration.getString('token_hash')!==$security.sha256(secret))fail(401,'Invalid integration credential')
  const org=integration.getString('organization'),selected=e.request.header.get('X-I7y-Organization')
  if(selected && selected!==org)fail(403,'Integration organization mismatch')
  find(app,'organizations',org)
  if(integration.getString('workspace_id'))inventoryContext(app,'workspace',integration.getString('workspace_id'),org)
  return integration
}
function invalidateIntegration(app,integration,now) {
  for(const incident of app.findRecordsByFilter('incidents','integration={:integration} && status="open"','',0,0,{integration:integration.id})){
    for(const notice of app.findRecordsByFilter('incident_notifications','incident={:incident} && valid=true','',0,0,{incident:incident.id})){notice.set('valid',false);app.save(notice)}
    incident.set('schedule_generation',incident.getInt('schedule_generation')+1)
    incident.set('version',incident.getInt('version')+1)
    incident.set('reminder_seconds',integration.getInt('reminder_seconds'))
    const claim=Date.parse(incident.getString('claim_until').replace(' ','T'))
    incident.set('next_reminder_at',integration.getBool('enabled')?new Date(Math.max(now+integration.getInt('reminder_seconds')*1000,Number.isFinite(claim)?claim:0)).toISOString():'')
    app.save(incident)
  }
}
function integrationBody(app,org,body,current) {
  if(!object(body))fail(400,'Invalid integration')
  if(current && ((body.kind!==undefined && body.kind!==current.getString('kind')) || (body.workspace_id!==undefined && body.workspace_id!==current.getString('workspace_id'))))fail(400,'Integration kind and workspace cannot be changed')
  const values={}
  if(!current || body.name!==undefined)values.name=text(body.name,'integration name',240,true)
  if(!current){values.kind=body.kind||'generic';if(!['generic','gcp'].includes(values.kind))fail(400,'Invalid integration kind');values.workspace_id=text(body.workspace_id,'workspace ID',15);if(values.workspace_id)inventoryContext(app,'workspace',values.workspace_id,org)}
  if(!current || body.enabled!==undefined){if(body.enabled!==undefined && typeof body.enabled!=='boolean')fail(400,'Invalid enabled flag');values.enabled=body.enabled!==false}
  if(!current || body.reminder_seconds!==undefined)values.reminder_seconds=interval(body.reminder_seconds)
  return values
}
function rotate(app,record) {
  const token='i7yh_'+$security.randomString(64)
  record.set('token_hash',$security.sha256(token));record.set('prefix',token.slice(0,13));app.save(record)
  return {...dto(record,'alert_integrations'),token}
}
function handle(e,operation) {
  e.response.header().set('Cache-Control','no-store')
  const engine=require(__hooks+'/lib/alerts.js')
  if(operation==='source-generic' || operation==='source-gcp'){
    let result
    e.app.runInTransaction(app=>{
      const kind=operation==='source-gcp'?'gcp':'generic',integration=credential(e,app,kind),body=e.requestInfo().body||{},org=integration.getString('organization')
      if(body.organization!==undefined && body.organization!==org)fail(403,'Integration organization mismatch')
      if(body.workspace_id!==undefined && body.workspace_id!==integration.getString('workspace_id'))fail(403,'Integration workspace mismatch')
      if(body.integration!==undefined && body.integration!==integration.id)fail(403,'Integration identity mismatch')
      const event=kind==='gcp'?normalizeGcp(body):normalizeEvent(body)
      result=receipt(app,org,'integration:'+integration.id,'source-event',e.request.header.get('Idempotency-Key'),body,()=>dto(mapped(()=>engine.sourceEvent(app,integration,event)),'incidents'))
      integration.set('last_received_at',new Date().toISOString())
      integration.set('last_event',{external_id:event.external_id,state:event.state,title:event.title,severity:event.severity,incident_id:result.id})
      app.save(integration)
    })
    return e.json(200,result)
  }
  if(['metrics','rules-list','rule-get','incidents-list','incident-get','integrations-list','integration-get','notifications','simulate'].includes(operation)){
    const integration=operation.indexOf('integration')===0,incident=operation.indexOf('incident')===0 || operation==='notifications'
    const p=permission(e,e.app,incident?'incidents:read':'alerts:read',false,integration)
    if(operation==='metrics')return e.json(200,{items:engine.catalog()})
    if(operation==='rules-list')return e.json(200,listing(e,e.app,'alert_rules',p.org))
    if(operation==='rule-get'){
      const rows=e.app.findRecordsByFilter('alert_rules','organization={:org} && key={:key} && archived=false','',1,0,{org:p.org,key:text(e.request.pathValue('key'),'rule key',120,true)})
      if(!rows.length)fail(404,'Rule not found')
      return e.json(200,dto(rows[0],'alert_rules'))
    }
    if(operation==='incidents-list')return e.json(200,listing(e,e.app,'incidents',p.org))
    if(operation==='incident-get'){
      const record=recordForOrg(e.app,'incidents',e.request.pathValue('id'),p.org)
      const events=e.app.findRecordsByFilter('incident_events','organization={:org} && incident={:incident}','occurred_at,created',0,0,{org:p.org,incident:record.id})
      return e.json(200,{...dto(record,'incidents'),events:events.map(r=>dto(r,'incident_events'))})
    }
    if(operation==='integrations-list')return e.json(200,listing(e,e.app,'alert_integrations',p.org))
    if(operation==='integration-get')return e.json(200,dto(recordForOrg(e.app,'alert_integrations',e.request.pathValue('id'),p.org),'alert_integrations'))
    if(operation==='notifications'){
      const cursor=query(e).get('cursor')||'0'
      if(!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))fail(400,'Invalid notification cursor')
      return e.json(200,engine.validNotifications(e.app,p.org,Number(cursor),positiveInteger(query(e).get('limit'),100,100)))
    }
    if(operation==='simulate')return e.json(200,mapped(()=>engine.simulate(e.app,p.org,ruleBody(e.app,p.org,e.requestInfo().body))))
  }
  let result
  e.app.runInTransaction(app=>{
    const sessionOnly=['claim','integration-create','integration-update','integration-delete','integration-rotate'].includes(operation)
    const capability=operation==='incident-create'?'incidents:create':operation==='resolve'?'incidents:resolve':'alerts:write'
    const p=permission(e,app,capability,true,sessionOnly),body=e.requestInfo().body||{},now=Date.now()
    const mcpRequest=e.request.header.get('X-I7y-MCP-Request')
    let mcpBinding=''
    if(mcpRequest){
      if(e.get('i7yApiToken') || !/^[a-f0-9]{32}$/.test(mcpRequest))fail(403,'Invalid desktop MCP request')
      mcpBinding=$security.sha256(canonical({operation,path:e.request.url.path,body,revision:e.request.header.get('X-I7y-Expected-Revision')}))
      const prior=app.findRecordsByFilter('mcp_receipts','organization={:org} && user={:user} && request_id={:id}','',1,0,{org:p.org,user:p.user.id,id:mcpRequest})
      if(prior.length){if(prior[0].getString('binding')!==mcpBinding)fail(409,'Request identity conflict');result=json(prior[0],'result',{});return}
    }
    if(['rule-save','rule-archive'].includes(operation) && e.request.header.get('X-I7y-Expected-Revision')){
      const expected=e.request.header.get('X-I7y-Expected-Revision')
      if(!/^\d+$/.test(expected))fail(400,'Invalid expected revision')
      const rows=app.findRecordsByFilter('alert_rules','organization={:org} && key={:key}','',1,0,{org:p.org,key:e.request.pathValue('key')})
      if(Number(expected)!==(rows.length?rows[0].getInt('edit_version'):0))fail(409,'Rule changed; review a new request')
    }
    if(operation==='rule-save'){
      const key=text(e.request.pathValue('key'),'rule key',120,true)
      if(!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key))fail(400,'Invalid rule key')
      result=dto(mapped(()=>engine.saveRule(app,p.org,key,ruleBody(app,p.org,body),p.user.id,now)),'alert_rules')
    }else if(operation==='rule-archive'){
      const rows=app.findRecordsByFilter('alert_rules','organization={:org} && key={:key}','',1,0,{org:p.org,key:text(e.request.pathValue('key'),'rule key',120,true)})
      if(!rows.length)fail(404,'Rule not found')
      mapped(()=>engine.archiveRule(app,rows[0],p.user.id,now))
    }else if(operation==='incident-create'){
      const normalized=incidentBody(app,p.org,body)
      result=receipt(app,p.org,p.producer,'incident-create',e.request.header.get('Idempotency-Key'),body,()=>dto(mapped(()=>engine.createIncident(app,p.org,normalized,p.user.id,now)),'incidents'),!!e.get('i7yApiToken'))
    }else if(operation==='claim' || operation==='resolve'){
      const record=recordForOrg(app,'incidents',e.request.pathValue('id'),p.org)
      version(body,record)
      result=dto(mapped(()=>operation==='claim'?engine.claim(app,record,p.user.id,claimDeadline(body.claim_until),body.version,now):engine.resolve(app,record,'manual',p.user.id,now)),'incidents')
    }else if(operation==='integration-create'){
      const values=integrationBody(app,p.org,body),record=new Record(app.findCollectionByNameOrId('alert_integrations'))
      record.set('organization',p.org)
      for(const key in values)record.set(key,values[key])
      result=rotate(app,record)
    }else if(['integration-update','integration-delete','integration-rotate'].includes(operation)){
      const record=recordForOrg(app,'alert_integrations',e.request.pathValue('id'),p.org)
      if(operation==='integration-rotate'){if(!record.getBool('enabled'))fail(400,'Enable the integration before rotating its credential');result=rotate(app,record)}
      else{
        const values=operation==='integration-delete'?{enabled:false,token_hash:'',prefix:''}:integrationBody(app,p.org,body,record)
        const schedule=values.enabled!==undefined && values.enabled!==record.getBool('enabled') || values.reminder_seconds!==undefined && values.reminder_seconds!==record.getInt('reminder_seconds')
        for(const key in values)record.set(key,values[key])
        app.save(record)
        if(schedule || operation==='integration-delete')invalidateIntegration(app,record,now)
        result=dto(record,'alert_integrations')
      }
    }else fail(404,'Unknown operation')
    if(mcpRequest){
      const receipt=new Record(app.findCollectionByNameOrId('mcp_receipts'));for(const [key,value] of Object.entries({organization:p.org,user:p.user.id,request_id:mcpRequest,binding:mcpBinding,result:result||{completed:true}}))receipt.set(key,value);app.save(receipt)
      require(__hooks+'/lib/desktop-mcp.js').audit(app,p,{request_id:mcpRequest+'-write',tool:operation,binding:mcpBinding,state:'completed'})
    }
  })
  if(operation==='rule-archive' || operation==='integration-delete')return e.noContent(204)
  return e.json(['incident-create','integration-create'].includes(operation)?201:200,result)
}
module.exports={handle,normalizeEvent,normalizeGcp,canonical,permission,credential,dto,receipt,inventoryContext,claimDeadline}
