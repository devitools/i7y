function fail(status,message){throw new ApiError(status,message)}
function id(value,name){if(typeof value!=='string' || !/^[a-z0-9]{15}$/.test(value))fail(400,'Invalid '+name);return value}
function records(app,collection,filter,params,sort='id'){return app.findRecordsByFilter(collection,filter,sort,0,0,params)}
function currentUser(e,app){return require(__hooks+'/lib/inbox.js').user(e,app)}
function authorize(app,user,source,destination){
  const lib=require(__hooks+'/lib/organizations.js')
  for(const org of [source,destination]){
    try{app.findRecordById('organizations',org)}catch(_){fail(404,'Organization not found')}
    if(lib.role(app,user,org)!=='admin')fail(403,'Administration of both organizations is required')
  }
}
function sourceRecord(app,integration,source){
  let record
  try{record=app.findRecordById('alert_integrations',integration)}catch(_){fail(404,'Integration not found')}
  if(record.getString('organization')!==source)fail(404,'Integration not found')
  return record
}
function preview(app,record,source,destination){
  const http=require(__hooks+'/lib/alerts-http.js'),integration=record.id
  const incidents=records(app,'incidents','integration={:integration}',{integration})
  if(incidents.some(incident=>incident.getString('organization')!==source))fail(409,'Integration history has inconsistent ownership')
  const snapshot={integration,source_organization:source,destination_organization:destination,updated:record.getString('updated'),token_hash:record.getString('token_hash'),incidents:incidents.map(incident=>({...http.dto(incident,'incidents'),source_key:incident.getString('source_key')}))}
  const events=records(app,'incident_events','organization={:org}',{org:source}).filter(event=>incidents.some(incident=>incident.id===event.getString('incident')))
  return {integration: http.dto(record,'alert_integrations'),source_organization:source,destination_organization:destination,plan_hash:$security.sha256(http.canonical(snapshot)),incident_count:incidents.length,open_count:incidents.filter(incident=>incident.getString('status')==='open').length,event_count:events.length,clears_workspace:record.getString('workspace_id')||null,incident_ids:incidents.map(incident=>incident.id)}
}
function apply(app,record,plan,user){
  const source=plan.source_organization,destination=plan.destination_organization,integration=record.id
  const engine=require(__hooks+'/lib/alerts.js'),roles=require(__hooks+'/lib/organizations.js'),now=Date.now()
  const incidents=records(app,'incidents','integration={:integration}',{integration}),ids=new Set(incidents.map(incident=>incident.id))
  for(const incident of incidents){
    const collision=records(app,'incidents','source_key={:key}',{key:JSON.stringify([destination,integration,incident.getString('external_id')])})
    if(collision.some(other=>other.id!==incident.id))fail(409,'Destination already contains this source identity')
  }
  for(const notice of records(app,'incident_notifications','organization={:source}',{source}).filter(notice=>ids.has(notice.getString('incident')))){
    notice.set('organization',destination);notice.set('valid',false);app.save(notice)
  }
  for(const event of records(app,'incident_events','organization={:source}',{source}).filter(event=>ids.has(event.getString('incident')))){
    event.set('organization',destination);app.save(event)
  }
  for(const outbox of records(app,'mobile_outbox','status="pending" || status="processing"',{}).filter(entry=>ids.has(entry.getString('incident_id')))){
    outbox.set('status','cancelled');outbox.set('reason','integration_transferred');outbox.set('lease_token','');outbox.set('lease_until','');app.save(outbox)
  }
  for(const incident of incidents){
    const previous={workspace_id:incident.getString('workspace_id'),server_id:incident.getString('server_id'),container_id:incident.getString('container_id'),assignee:incident.getString('assignee'),claim_until:incident.getString('claim_until')}
    incident.set('organization',destination)
    incident.set('source_key',JSON.stringify([destination,integration,incident.getString('external_id')]))
    for(const field of ['workspace_id','server_id','container_id'])incident.set(field,'')
    let assignee=null
    if(previous.assignee){try{assignee=app.findRecordById('users',previous.assignee)}catch(_){}}
    if(previous.assignee && !roles.role(app,assignee,destination)){incident.set('assignee','');incident.set('claim_until','')}
    incident.set('version',incident.getInt('version')+1)
    incident.set('schedule_generation',incident.getInt('schedule_generation')+1)
    if(incident.getString('status')==='open'){
      const claim=Date.parse(incident.getString('claim_until').replace(' ','T'))
      incident.set('next_reminder_at',record.getBool('enabled')?new Date(Math.max(now+record.getInt('reminder_seconds')*1000,Number.isFinite(claim)?claim:0)).toISOString():'')
    }
    app.save(incident)
    engine.audit(app,incident,'integration_transferred',user.id,{source_organization:source,destination_organization:destination,previous},now)
  }
  for(const receipt of records(app,'alert_receipts','organization={:source} && producer={:producer}',{source,producer:'integration:'+integration})){
    const previous=engine.json(receipt,'result')||{}
    receipt.set('organization',destination)
    if(ids.has(previous.id))receipt.set('result',require(__hooks+'/lib/alerts-http.js').dto(app.findRecordById('incidents',previous.id),'incidents'))
    app.save(receipt)
  }
  record.set('organization',destination);record.set('workspace_id','');app.save(record)
  const result={integration,source_organization:source,destination_organization:destination,plan_hash:plan.plan_hash,incident_count:incidents.length,event_count:plan.event_count,incident_ids:plan.incident_ids}
  const receipt=new Record(app.findCollectionByNameOrId('alert_integration_transfers'))
  for(const [key,value] of Object.entries({...result,actor:user.id,result}))if(['integration','source_organization','destination_organization','plan_hash','actor','result'].includes(key))receipt.set(key,value)
  app.save(receipt)
  return {...result,receipt_id:receipt.id}
}
function handle(e,write){
  e.response.header().set('Cache-Control','no-store')
  const body=e.requestInfo().body||{},integration=id(e.request.pathValue('id'),'integration'),source=id(e.request.header.get('X-I7y-Organization'),'source organization'),destination=id(body.destination_organization,'destination organization')
  if(source===destination)fail(400,'Choose a different destination organization')
  if(write && (typeof body.plan_hash!=='string' || !/^[a-f0-9]{64}$/.test(body.plan_hash)))fail(400,'Preview the transfer before applying it')
  let result
  e.app.runInTransaction(app=>{
    const user=currentUser(e,app)
    authorize(app,user,source,destination)
    if(write){
      const existing=records(app,'alert_integration_transfers','integration={:integration} && plan_hash={:hash}',{integration,hash:body.plan_hash})[0]
      if(existing){
        if(existing.getString('source_organization')!==source || existing.getString('destination_organization')!==destination)fail(409,'Transfer context changed')
        const saved=require(__hooks+'/lib/alerts.js').json(existing,'result')
        result={...saved,receipt_id:existing.id};return
      }
    }
    const record=sourceRecord(app,integration,source),plan=preview(app,record,source,destination)
    if(!write){result=plan;return}
    if(plan.plan_hash!==body.plan_hash)fail(409,'Integration changed; preview the transfer again')
    result=apply(app,record,plan,user)
  })
  return e.json(200,result)
}
module.exports={handle,preview,apply}
