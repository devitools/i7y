function rows(app,name,filter='',params={},sort='',limit=0) {return app.findRecordsByFilter(name,filter,sort,limit,0,params)}
function string(record,key) {return record.getString(key)}
function timestamp(value) {return Date.parse(String(value || '').replace(' ','T'))}
function iso(now) {return new Date(now).toISOString()}
function fail(status,message) {throw new ApiError(status,message)}
function installation(app) {return app.findFirstRecordByFilter('mobile_installation','key="installation"').getString('instance_id')}
function configuration(env) {
  const key=String(env('I7Y_MOBILE_ENCRYPTION_KEY') || ''),url=String(env('I7Y_PUSH_GATEWAY_URL') || '').replace(/\/$/,'')
  const origin=url.match(/^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i)
  const https=Boolean(origin && origin[1].split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) && (!origin[2] || (Number(origin[2])>0 && Number(origin[2])<=65535)) && (!/(?:^localhost$|\.localhost$|^127\.)/i.test(origin[1]) || env('I7Y_MOBILE_TEST_MODE')==='1'))
  const loopback=env('I7Y_MOBILE_TEST_MODE')==='1' && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(url)
  return {enabled:/^[\x21-\x7e]{32}$/.test(key) && (https || loopback),key,url}
}
function settings() {return configuration(name=>$os.getenv(name))}
function proof(body,instance,verifier) {
  return body && (body.locale===undefined || ['en','pt-BR','uk'].includes(body.locale)) && (body.time_zone===undefined || (typeof body.time_zone==='string' && /^[A-Za-z0-9_+./-]{1,80}$/.test(body.time_zone))) && /^[a-f0-9]{64}$/.test(String(body.request)) && /^[a-f0-9]{64}$/.test(String(body[verifier?'verifier':'challenge'])) && body.instance_id===instance && (!body.audience || body.audience==='mobile')
}
function session(e,app=e.app) {
  const token=e.request.header.get('Authorization').replace(/^Bearer\s+/i,'').trim()
  if(!e.auth || e.auth.collection().name!=='users' || e.get('i7yApiToken') || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))fail(401,'A user session is required')
  try {return app.findRecordById('users',e.auth.id)} catch (_) {fail(401,'User session is no longer valid')}
}
function access(app,user,organization) {
  if(!user)return false
  try {app.findRecordById('organizations',organization)}catch(_){return false}
  return Boolean(require(__hooks+'/lib/organizations.js').role(app,user,organization))
}
function deviceLocale(value) {return ['en','pt-BR','uk'].includes(value)?value:'en'}
function deviceTimeZone(value) {return typeof value==='string' && /^[A-Za-z0-9_+./-]{1,80}$/.test(value)?value:'UTC'}
function deviceInput(body) {
  return body && (body.locale===undefined || ['en','pt-BR','uk'].includes(body.locale)) && (body.time_zone===undefined || (typeof body.time_zone==='string' && /^[A-Za-z0-9_+./-]{1,80}$/.test(body.time_zone))) && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(body.connection_id)) && /^[A-Za-z0-9_-]{16,128}$/.test(String(body.binding_id)) && /^[A-Za-z0-9_.-]{24,512}$/.test(String(body.send_token))
}
function metadata(record) {return {id:record.id,connection_id:string(record,'connection_id'),binding_id:string(record,'binding_id'),active:record.getBool('active'),locale:deviceLocale(string(record,'locale')),time_zone:deviceTimeZone(string(record,'time_zone')),created:string(record,'created')}}
function newRecord(app,collection,values) {
  const record=new Record(app.findCollectionByNameOrId(collection))
  for(const key of Object.keys(values))record.set(key,values[key])
  app.save(record)
  return record
}
function handle(e,operation) {
  e.response.header().set('Cache-Control','no-store')
  const instance=installation(e.app),config=settings(),body=e.requestInfo().body || {}
  if(operation==='info')return e.json(200,{instance_id:instance,protocol_version:1,capabilities:['browser_login','incidents',...(config.enabled?['push']:[])],...(config.enabled?{push_gateway_url:config.url}:{})})
  if(operation==='authorize'){
    if(!proof(body,instance,false))fail(400,'Invalid mobile authorization request')
    e.app.runInTransaction(app=>{
      const user=session(e,app)
      newRecord(app,'mobile_authorizations',{request_hash:$security.sha256(body.request),challenge:body.challenge,audience:'mobile',instance_id:instance,user:user.id,expires_at:iso(Date.now()+120000),consumed:false})
    })
    return e.noContent(204)
  }
  if(operation==='exchange'){
    if(!proof(body,instance,true))fail(400,'Invalid mobile exchange request')
    let user=null
    e.app.runInTransaction(app=>{
      let authorization
      try {authorization=app.findFirstRecordByFilter('mobile_authorizations','request_hash={:hash}',{hash:$security.sha256(body.request)})} catch (_) {return}
      const expiry=timestamp(string(authorization,'expires_at'))
      if(authorization.getBool('consumed') || !Number.isFinite(expiry) || expiry<=Date.now() || string(authorization,'audience')!=='mobile' || string(authorization,'instance_id')!==instance)fail(400,'Mobile authorization expired')
      if(!$security.equal(string(authorization,'challenge'),$security.sha256(body.verifier)))fail(400,'Invalid mobile proof')
      user=app.findRecordById('users',string(authorization,'user'))
      authorization.set('consumed',true)
      app.save(authorization)
    })
    if(!user)return e.json(202,{pending:true,instance_id:instance})
    return $apis.recordAuthResponse(e,user,'mobile',{instance_id:instance})
  }
  const user=session(e)
  if(operation==='devices-list')return e.json(200,{items:rows(e.app,'mobile_devices','user={:user}',{user:user.id},'-created',100).map(metadata)})
  if(operation==='device-save'){
    if(!config.enabled)fail(503,'Mobile push is not configured on this installation')
    if(!deviceInput(body))fail(400,'Invalid mobile device binding')
    let saved
    e.app.runInTransaction(app=>{
      const current=session(e,app)
      let device=rows(app,'mobile_devices','connection_id={:connection}',{connection:body.connection_id})[0]
      if(device && string(device,'user')!==current.id)fail(404,'Device not found')
      const binding=rows(app,'mobile_devices','binding_id={:binding}',{binding:body.binding_id})[0]
      if(binding && (!device || binding.id!==device.id))fail(409,'Binding is already registered')
      if(!device && rows(app,'mobile_devices','user={:user} && active=true',{user:current.id},'',21).length>=20)fail(400,'Revoke a device before registering another')
      const latest=rows(app,'incident_notifications','',{},'-sequence',1)
      const start=latest.length?latest[0].getInt('sequence'):0
      const isNew=!device
      if(isNew)device=new Record(app.findCollectionByNameOrId('mobile_devices'))
      if(isNew || !device.getBool('active') || string(device,'binding_id')!==body.binding_id){device.set('start_sequence',start);device.set('cursor',start)}
      for(const [key,value] of Object.entries({user:current.id,instance_id:instance,connection_id:body.connection_id,binding_id:body.binding_id,send_token_encrypted:$security.encrypt(body.send_token,config.key),locale:deviceLocale(body.locale),time_zone:deviceTimeZone(body.time_zone),active:true}))device.set(key,value)
      app.save(device)
      saved=metadata(device)
    })
    return e.json(200,saved)
  }
  if(operation==='device-locale'){
    if(!body || !['en','pt-BR','uk'].includes(body.locale) || (body.time_zone!==undefined && (typeof body.time_zone!=='string' || !/^[A-Za-z0-9_+./-]{1,80}$/.test(body.time_zone))))fail(400,'Unsupported notification preferences')
    let saved
    e.app.runInTransaction(app=>{
      const current=session(e,app)
      let device
      try {device=app.findRecordById('mobile_devices',e.request.pathValue('id'))}catch(_){fail(404,'Device not found')}
      if(string(device,'user')!==current.id || !device.getBool('active'))fail(404,'Device not found')
      device.set('locale',body.locale);if(body.time_zone!==undefined)device.set('time_zone',body.time_zone);app.save(device);saved=metadata(device)
    })
    return e.json(200,saved)
  }
  if(operation==='device-delete'){
    e.app.runInTransaction(app=>{
      const current=session(e,app)
      let device
      try {device=app.findRecordById('mobile_devices',e.request.pathValue('id'))}catch(_){fail(404,'Device not found')}
      if(string(device,'user')!==current.id)fail(404,'Device not found')
      device.set('active',false)
      app.save(device)
      for(const entry of rows(app,'mobile_outbox','device={:device} && (status="pending" || status="processing")',{device:device.id}))finish(app,entry,'cancelled','device_revoked')
    })
    return e.noContent(204)
  }
  fail(404,'Mobile endpoint not found')
}
function eligible(notice,incident,device,now) {
  const kind=string(notice,'kind'),resolved=kind==='resolved'
  const matchingState=string(incident,'status')===(resolved?'resolved':'open')
  const scheduleAllowed=resolved || (['claimed','claim_extended'].includes(kind)?timestamp(string(incident,'claim_until'))>now:!(timestamp(string(incident,'claim_until'))>now))
  return device.getBool('active') && notice.getBool('valid') && notice.getInt('sequence')>device.getInt('start_sequence') && matchingState && string(notice,'organization')===string(incident,'organization') && notice.getInt('schedule_generation')===incident.getInt('schedule_generation') && scheduleAllowed
}
function current(app,notice,device,now) {
  try {
    if(string(device,'instance_id')!==installation(app))return null
    const user=app.findRecordById('users',string(device,'user')),incident=app.findRecordById('incidents',string(notice,'incident'))
    if(!eligible(notice,incident,device,now) || !access(app,user,string(incident,'organization')))return null
    const resolved=string(notice,'kind')==='resolved'
    if(string(incident,'rule')){
      const rule=app.findRecordById('alert_rules',string(incident,'rule'))
      if(string(rule,'organization')!==string(incident,'organization') || (!resolved && (!rule.getBool('enabled') || rule.getBool('archived') || rule.getInt('revision')!==incident.getInt('rule_revision'))))return null
    }
    if(string(incident,'integration')){
      const integration=app.findRecordById('alert_integrations',string(incident,'integration'))
      if(string(integration,'organization')!==string(incident,'organization') || (!resolved && !integration.getBool('enabled')))return null
    }
    if(rows(app,'incident_notifications','incident={:incident} && sequence>{:sequence}',{incident:incident.id,sequence:notice.getInt('sequence')},'',1).length)return null
    return incident
  }catch(_){return null}
}
function queue(app,notice,device) {
  const incident=current(app,notice,device,Date.now())
  if(!incident)return
  if(rows(app,'mobile_outbox','device={:device} && notification={:notice}',{device:device.id,notice:notice.id},'',1).length)return
  const eventId=notice.id+'-'+device.id
  let assigneeName=''
  let actorId=string(incident,'assignee')
  if(string(notice,'kind')==='resolved'){const event=rows(app,'incident_events','incident={:incident} && kind="resolved"',{incident:incident.id},'-occurred_at',1)[0];actorId=event?string(event,'actor'):''}
  if(actorId){try {const owner=app.findRecordById('users',actorId);assigneeName=string(owner,'name') || string(owner,'email')}catch(_){}}
  newRecord(app,'mobile_outbox',{device:device.id,notification:notice.id,incident_id:string(notice,'incident'),event_id:eventId,payload_json:JSON.stringify(projection(incident,eventId,string(device,'locale'),string(device,'time_zone'),Date.now(),string(notice,'kind'),assigneeName)),status:'pending',attempts:0,next_attempt_at:iso(Date.now())})
}
function enqueue(app,notice) {
  if(!settings().enabled)return
  app.runInTransaction(tx=>{
    const fresh=tx.findRecordById('incident_notifications',notice.id)
    for(const device of rows(tx,'mobile_devices','active=true'))queue(tx,fresh,device)
  })
}
function catchUp(app) {
  if(!settings().enabled)return
  for(const device of rows(app,'mobile_devices','active=true')){
    app.runInTransaction(tx=>{
      const fresh=tx.findRecordById('mobile_devices',device.id)
      for(const notice of rows(tx,'incident_notifications','sequence>{:cursor}',{cursor:fresh.getInt('cursor')},'sequence',200)){
        queue(tx,notice,fresh)
        fresh.set('cursor',notice.getInt('sequence'))
      }
      tx.save(fresh)
    })
  }
}
function pushText(value,limit) {
  let result='',bytes=0
  for(const character of String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim()){
    const point=character.codePointAt(0),size=point<=127?1:point<=2047?2:point<=65535?3:4
    if(bytes+size>limit)break
    result+=character;bytes+=size
  }
  return result.trim()
}
function projection(incident,eventId,locale='en',timeZone='UTC',now=Date.now(),kind='',assigneeName='') {
  const severity=['info','warning','critical'].includes(string(incident,'severity'))?string(incident,'severity'):'warning'
  const messages=require(__hooks+'/lib/locales/mobile-push.js')[deviceLocale(locale)]
  const resource=pushText(string(incident,'resource_name'),100)
  const deadline=timestamp(string(incident,'claim_until'))
  const overdue=string(incident,'status')==='open' && Number.isFinite(deadline) && deadline<=now
  const claimed=['claimed','claim_extended'].includes(kind) && Number.isFinite(deadline) && deadline>now
  const owner=pushText(assigneeName,80)
  const alertName=pushText(string(incident,'title'),100) || messages.fallback
  const resolved=kind==='resolved' && string(incident,'status')==='resolved'
  const resolvedAt=timestamp(string(incident,'resolved_at'))
  const resolvedTemplate=string(incident,'resolution_reason')==='manual'?(owner?messages.resolvedBy:messages.resolved):string(incident,'resolution_reason')==='recovered'?messages.recovered:messages.resolvedAutomatic
  const template=resolved?resolvedTemplate:kind==='claim_extended'?messages.extended:claimed?messages.claimed:overdue?messages.overdue:messages.open
  const message=(resource?resource+': ':'')+alertName+' — '+template.replace('{severity}',messages[severity]).replace('{assignee}',owner || messages.unnamed)+(overdue && !resolved && owner?' '+messages.assignee.replace('{assignee}',owner):'')+(resolved?'':overdue?' '+messages.deadline:claimed && kind!=='claim_extended'?' '+messages.claimDeadline:'')
  const marker=resolved?'✅':claimed?'👤':overdue?'⏰':{critical:'🚨',warning:'⚠️',info:'ℹ️'}[severity]
  return {event_id:eventId,incident_id:incident.id,organization_id:string(incident,'organization'),title:'[i7y] '+(pushText(string(incident,'title'),106) || messages.fallback)+' '+marker,resource:pushText(message,512),severity,ttl:60,...((overdue || claimed || resolved)?{deadline_at:iso(resolved?resolvedAt:deadline),locale:deviceLocale(locale),time_zone:deviceTimeZone(timeZone)}:{})}
}
function outcome(status,data) {
  if(data && data.code==='invalid_token')return 'invalid'
  if(status>=200 && status<300)return data && data.status==='invalid'?'invalid':'accepted'
  if([401,403,404,410].includes(status))return 'invalid'
  if(status===408 || status===429 || status>=500 || status===0)return 'retry'
  return 'permanent_failure'
}
function retryDelay(attempt) {return Math.min(3600000,15000*Math.pow(2,Math.max(0,attempt-1)))}
function finish(app,entry,status,reason) {
  entry.set('status',status);entry.set('reason',reason || '');entry.set('lease_until','');entry.set('lease_token','');app.save(entry)
}
function dispatch(app) {
  const config=settings()
  if(!config.enabled)return
  const now=Date.now()
  const candidates=rows(app,'mobile_outbox','(status="pending" && next_attempt_at<={:now}) || (status="processing" && lease_until<={:now})',{now:iso(now)},'created',100)
  for(const candidate of candidates){
    let lease='',payload='',eventId='',binding='',secret=''
    app.runInTransaction(tx=>{
      const entry=tx.findRecordById('mobile_outbox',candidate.id)
      if(!['pending','processing'].includes(string(entry,'status')) || (string(entry,'status')==='processing' && timestamp(string(entry,'lease_until'))>Date.now()) || (string(entry,'status')==='pending' && timestamp(string(entry,'next_attempt_at'))>Date.now()))return
      const device=tx.findRecordById('mobile_devices',string(entry,'device')),notice=tx.findRecordById('incident_notifications',string(entry,'notification')),incident=current(tx,notice,device,Date.now())
      if(!incident){finish(tx,entry,'cancelled','notice_no_longer_valid');return}
      try {secret=toString($security.decrypt(string(device,'send_token_encrypted'),config.key))}catch(_){finish(tx,entry,'permanent_failure','encryption_key_unavailable');return}
      payload=string(entry,'payload_json');eventId=string(entry,'event_id')
      let frozen
      try {frozen=JSON.parse(payload)}catch(_){finish(tx,entry,'permanent_failure','invalid_saved_payload');return}
      if(!frozen || typeof frozen!=='object' || Array.isArray(frozen) || frozen.event_id!==eventId || frozen.incident_id!==incident.id || frozen.organization_id!==string(incident,'organization')){finish(tx,entry,'permanent_failure','invalid_saved_payload');return}
      lease=$security.randomString(32);binding=string(device,'binding_id')
      entry.set('status','processing');entry.set('attempts',entry.getInt('attempts')+1);entry.set('lease_until',iso(Date.now()+30000));entry.set('lease_token',lease);tx.save(entry)
    })
    if(!lease)continue
    let result='retry'
    try {
      const response=$http.send({url:config.url+'/v1/bindings/'+binding+'/notifications',method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json','Idempotency-Key':eventId},body:payload,timeout:10})
      result=outcome(response.statusCode,response.json)
    }catch(_){}
    app.runInTransaction(tx=>{
      const entry=tx.findRecordById('mobile_outbox',candidate.id)
      if(string(entry,'status')!=='processing' || string(entry,'lease_token')!==lease)return
      const device=tx.findRecordById('mobile_devices',string(entry,'device')),notice=tx.findRecordById('incident_notifications',string(entry,'notification'))
      if(!current(tx,notice,device,Date.now())){finish(tx,entry,'cancelled','notice_no_longer_valid');return}
      if(result==='retry' && entry.getInt('attempts')<8){entry.set('next_attempt_at',iso(Date.now()+retryDelay(entry.getInt('attempts'))));finish(tx,entry,'pending','transient_gateway_failure')}
      else {finish(tx,entry,result==='retry'?'permanent_failure':result,result==='retry'?'retry_limit':'');if(result==='invalid'){device.set('active',false);tx.save(device)}}
    })
  }
}
function cleanup(app) {
  for(const record of rows(app,'mobile_authorizations','expires_at<{:cutoff}',{cutoff:iso(Date.now()-86400000)},'',200))app.delete(record)
  for(const record of rows(app,'mobile_outbox','status!="pending" && status!="processing" && updated<{:cutoff}',{cutoff:iso(Date.now()-2592000000)},'',200))app.delete(record)
}
module.exports={deviceLocale,handle,configuration,proof,deviceInput,eligible,projection,outcome,retryDelay,enqueue,catchUp,dispatch,cleanup}
