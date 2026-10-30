const actions=['server.inspect','server.disk','container.list','container.start','container.stop','container.restart']
function fail(status,message){throw new ApiError(status,message)}
function text(value,max=64){if(typeof value!=='string'||!value.length||value.length>max||!/^[a-zA-Z0-9_.-]+$/.test(value))fail(400,'Invalid identifier');return value}
function human(e,app,admin=false){if(e.get('i7yApiToken'))fail(403,'A human session is required');const org=text(e.request.header.get('X-I7y-Organization'),15),lib=require(__hooks+'/lib/organizations.js');const role=lib.role(app,e.auth,org);if(!role||(admin&&role!=='admin'))fail(403,'Organization access denied');return {org,user:app.findRecordById('users',e.auth.id)}}
function permission(app,org,user,action,target){
  if(!actions.includes(action))fail(403,'Action is not available')
  const lib=require(__hooks+'/lib/organizations.js');if(!lib.role(app,user,org))fail(403,'Organization access denied')
  let record;try{record=app.findRecordById(action.startsWith('container.')&&action!=='container.list'?'containers':'servers',target)}catch(_){fail(404,'Target not found')}
  if(lib.organization(app,record)!==org)fail(404,'Target not found')
  const grants=app.findRecordsByFilter('operation_grants','organization={:org} && user={:user} && action={:action} && target={:target} && enabled=true','',1,0,{org,user:user.id,action,target})
  if(!grants.length)fail(403,'Explicit operation permission required')
}
function audit(app,p,body){
  const values={request_id:text(body.request_id),tool:text(body.tool),binding:text(body.binding),state:text(body.state,32)}
  if(!['approved','denied','completed','failed','unknown'].includes(values.state))fail(400,'Invalid audit state')
  const existing=app.findRecordsByFilter('mcp_audit','organization={:org} && user={:user} && request_id={:id} && state={:state}','',1,0,{org:p.org,user:p.user.id,id:values.request_id,state:values.state})
  if(existing.length){if(existing[0].getString('binding')!==values.binding)fail(409,'Request identity conflict');return {recorded:true}}
  const record=new Record(app.findCollectionByNameOrId('mcp_audit'));record.set('organization',p.org);record.set('user',p.user.id);for(const key in values)record.set(key,values[key]);app.save(record);return {recorded:true}
}
function handle(e,operation){let result;e.app.runInTransaction(app=>{
  const body=e.requestInfo().body||{}
  if(operation==='consume'){
    const secret=e.request.header.get('Authorization').replace(/^Bearer\s+/i,'').trim()
    if(!/^i7yc_[A-Za-z0-9]{64}$/.test(secret))fail(401,'Invalid controller identity')
    const controllers=app.findRecordsByFilter('operation_controllers','token_hash={:hash} && enabled=true','',1,0,{hash:$security.sha256(secret)})
    if(!controllers.length)fail(401,'Controller identity revoked')
    const controller=controllers[0],org=controller.getString('organization'),principal=controller.getString('principal')
    const tickets=app.findRecordsByFilter('operation_tickets','token_hash={:hash}','',1,0,{hash:$security.sha256(String(body.ticket||''))})
    if(!tickets.length)fail(403,'Invalid operation ticket')
    const ticket=tickets[0]
    for(const key of ['operation_id','action','target','approval'])if(ticket.getString(key)!==body[key])fail(403,'Operation ticket mismatch')
    if(ticket.getString('organization')!==org||ticket.getString('principal')!==principal||body.principal!==principal||ticket.getBool('consumed')||Date.parse(ticket.getString('expires_at').replace(' ','T'))<=Date.now())fail(403,'Operation ticket expired or consumed')
    const user=app.findRecordById('users',ticket.getString('user'));permission(app,org,user,body.action,body.target)
    ticket.set('consumed',true);app.save(ticket);result={authorized:true,user:user.id};return
  }
  const p=human(e,app,['grant','controller'].includes(operation))
  if(operation==='receipt-get'){
    const id=e.request.pathValue('id')
    if(!/^[a-f0-9]{32}$/.test(id))fail(400,'Invalid request identity')
    const rows=app.findRecordsByFilter('mcp_receipts','organization={:org} && user={:user} && request_id={:id}','',1,0,{org:p.org,user:p.user.id,id})
    result=rows.length?{request_id:id,state:'completed',result:JSON.parse(rows[0].getString('result'))}:{request_id:id,state:'unknown'}
    return
  }
  if(operation==='audit'){result=audit(app,p,body);return}
  if(operation==='audit-list'){result={items:app.findRecordsByFilter('mcp_audit','organization={:org} && user={:user}','-created',100,0,{org:p.org,user:p.user.id}).map(r=>({request_id:r.getString('request_id'),tool:r.getString('tool'),state:r.getString('state'),created:r.getString('created')}))};return}
  if(operation==='controller'){
    const secret='i7yc_'+$security.randomString(64),record=new Record(app.findCollectionByNameOrId('operation_controllers'));record.set('organization',p.org);record.set('principal',text(body.principal));record.set('token_hash',$security.sha256(secret));record.set('enabled',true);app.save(record);result={id:record.id,token:secret};return
  }
  if(operation==='grant'){
    const user=app.findRecordById('users',text(body.user,15));if(!require(__hooks+'/lib/organizations.js').role(app,user,p.org))fail(403,'User must belong to the organization')
    const action=text(body.action),target=text(body.target,15);if(!actions.includes(action))fail(400,'Unsupported operation action')
    const found=app.findRecordsByFilter('operation_grants','organization={:org} && user={:user} && action={:action} && target={:target}','',1,0,{org:p.org,user:user.id,action,target})
    const record=found[0]||new Record(app.findCollectionByNameOrId('operation_grants'));for(const [key,value]of Object.entries({organization:p.org,user:user.id,action,target,enabled:body.enabled===true}))record.set(key,value);app.save(record);result={id:record.id};return
  }
  if(operation==='status-access'){
    const operationId=text(body.operation_id)
    const rows=app.findRecordsByFilter('operation_tickets','organization={:org} && user={:user} && operation_id={:id} && consumed=true','',1,0,{org:p.org,user:p.user.id,id:operationId})
    if(!rows.length)fail(404,'Operation not found')
    result={authorized:true};return
  }
  if(operation==='check'||operation==='ticket'){
    const action=text(body.action),target=text(body.target,15);permission(app,p.org,p.user,action,target)
    if(operation==='check'){result={authorized:true};return}
    const approval=text(body.approval);if(!/^[a-f0-9]{64}$/.test(approval))fail(400,'Invalid reviewed plan hash')
    const secret='i7yo_'+$security.randomString(64),record=new Record(app.findCollectionByNameOrId('operation_tickets'))
    for(const [key,value]of Object.entries({organization:p.org,user:p.user.id,principal:text(body.principal),action,target,approval,operation_id:text(body.operation_id),token_hash:$security.sha256(secret),expires_at:new Date(Date.now()+60000).toISOString(),consumed:false}))record.set(key,value)
    app.save(record);result={ticket:secret};return
  }
  fail(404,'Unknown MCP operation')
});return e.json(200,result)}
module.exports={handle,permission,audit}
