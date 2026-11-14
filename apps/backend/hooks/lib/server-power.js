const actions=['inspect','start','shutdown']
const stages=['checking_provider','power_on_requested','power_off_requested','waiting_for_boot','checking_boot','unlocking_disk','awaiting_agent','powered_off','requires_console','provider_on','provider_off','unknown','failed']
const reasons=['','provider_unavailable','provider_rejected','provider_target_missing','vault_unavailable','vault_unsupported','boot_unavailable','boot_identity_mismatch','disk_key_rejected','unlock_unconfirmed','runtime_unavailable','context_changed','operation_interrupted','invalid_target','agent_timeout']
function fail(status,message){throw new ApiError(status,message)}
function rows(app,name,filter,params={},sort='',limit=100){return app.findRecordsByFilter(name,filter,sort,limit,0,params)}
function date(value){return Date.parse(String(value||'').replace(' ','T'))||0}
function json(record,key,fallback={}){try{return JSON.parse(record.getString(key)||'null')||fallback}catch(_){return fallback}}
function credential(record){try{const value=require(__hooks+'/lib/vault-reference.js').normalize(json(record,'credential'));if(!value)throw new Error();return value}catch(_){fail(409,'Configure the credential references in the server and workspace inventory first')}}
function configuration(c){
  const references={server:c.server.id,workspace:c.workspace.id,address:c.server.getString('ip'),provider_credential:credential(c.workspace),disk_credential:credential(c.server)}
  return {...references,credential_binding:$security.sha256(JSON.stringify(references))}
}
function context(e,app,write=false,admin=false){
  if(e.get('i7yApiToken'))fail(403,'A user session is required')
  const user=app.findRecordById('users',e.auth.id),server=app.findRecordById('servers',e.request.pathValue('id')),lib=require(__hooks+'/lib/organizations.js'),org=lib.organization(app,server)
  if(e.request.header.get('X-I7y-Organization')!==org)fail(403,'Organization context changed')
  const role=lib.requireRole({app,auth:user,requestInfo:()=>e.requestInfo()},org,write,admin)
  if(server.getString('type')!=='VPS')fail(400,'This action requires a VPS')
  const workspace=app.findRecordById('workspaces',server.getString('workspace'))
  return {user,server,workspace,org,role}
}
function profile(app,c){return rows(app,'server_power_profiles','server={:server} && organization={:org}',{server:c.server.id,org:c.org},'',1)[0]}
function target(app,c){
  const p=profile(app,c);if(!p)fail(409,'Configure the SNEL server mapping first')
  const configured=configuration(c)
  if(!p.getString('credential_binding')||p.getString('credential_binding')!==configured.credential_binding)fail(409,'Reload the VM configuration from its linked credential item')
  if(!/snel/i.test(c.workspace.getString('provider')+' '+c.workspace.getString('query')))fail(409,'This server is not mapped to SNEL')
  return {id:c.server.id,organization:c.org,name:c.server.getString('name'),address:c.server.getString('ip'),service_id:p.getString('service_id'),vm_id:p.getString('vm_id'),version:p.getInt('version'),provider_credential:configured.provider_credential,disk_credential:configured.disk_credential,boot_port:p.getInt('boot_port'),boot_host_key:p.getString('boot_host_key'),luks_uuid:p.getString('luks_uuid')}
}
function binding(value){return $security.sha256(JSON.stringify(value))}
function providerKey(value){return $security.sha256('snel:'+value.service_id+':'+value.vm_id)}
function dto(record){const out={id:record.id};for(const key of ['user','request_id','action','status','stage','reason','reconciled_by','started_at','finished_at','created','updated'])out[key]=record.getString(key);return out}
function contact(app,server){const latest=rows(app,'telemetry_samples','server={:server}',{server},'-observed_at',1)[0];return latest?Math.min(date(latest.getString('observed_at')),date(latest.getString('received_at')),Date.now()):0}
function refresh(app,job){
  if(job.getString('status')==='running'&&Date.now()-date(job.getString('started_at'))>600000){job.set('status','unknown');job.set('stage','unknown');job.set('reason','operation_interrupted');app.save(job)}
  if(job.getString('action')==='start'&&['awaiting_agent','unknown'].includes(job.getString('status'))&&contact(app,job.getString('server'))>date(job.getString('started_at'))){job.set('status','recovered');job.set('stage','agent_connected');job.set('finished_at',new Date().toISOString());app.save(job)}
}
function handle(e,operation){let result;e.app.runInTransaction(app=>{
  const c=context(e,app,operation!=='get',operation==='save'||operation==='reconcile'),body=e.requestInfo().body||{},p=profile(app,c)
  if(operation==='get'){
    const jobs=rows(app,'server_power_jobs','server={:server} && organization={:org}',{server:c.server.id,org:c.org},'-created',10)
    const key=p?providerKey({service_id:p.getString('service_id'),vm_id:p.getString('vm_id')}):''
    const active=rows(app,'server_power_jobs','(server={:server} || provider_key={:key}) && organization={:org} && (status="running" || status="unknown")',{server:c.server.id,key,org:c.org},'',1)[0]
    if(active&&!jobs.some(job=>job.id===active.id))jobs.push(active)
    for(const job of jobs)refresh(app,job)
    let configured=null;try{configured=configuration(c)}catch(_){}
    const references={};for(const [key,record]of [['server',c.server],['workspace',c.workspace]]){try{references[key]=credential(record)}catch(_){references[key]=null}}
    result={credentials:references,configuration:configured,configuration_current:!!p&&!!configured&&p.getString('credential_binding')===configured.credential_binding,workspace:c.workspace.id,id:c.server.id,name:c.server.getString('name'),address:c.server.getString('ip'),provider_supported:/snel/i.test(c.workspace.getString('provider')+' '+c.workspace.getString('query')),can_edit:['admin','editor'].includes(c.role),can_configure:c.role==='admin',profile:p?{service_id:p.getString('service_id'),vm_id:p.getString('vm_id'),boot_host_key:p.getString('boot_host_key'),luks_uuid:p.getString('luks_uuid'),boot_port:p.getInt('boot_port'),version:p.getInt('version')}:null,jobs:jobs.map(dto)};return
  }
  if(operation==='save'){
    if(rows(app,'server_power_jobs','server={:server} && (status="running" || status="unknown")',{server:c.server.id},'',1).length)fail(409,'Reconcile the current operation before changing its target')
    if((p?p.getInt('version'):0)!==body.version)fail(409,'Server settings changed; reload before saving')
    if(Object.keys(body).some(k=>!['version','service_id','vm_id','boot_port','boot_host_key','luks_uuid','credential_binding'].includes(k)))fail(400,'Unsupported setting')
    const configured=configuration(c)
    if(body.credential_binding!==configured.credential_binding)fail(409,'The inventory reference changed; reload the credential configuration')
    if(typeof body.service_id!=='string'||typeof body.vm_id!=='string'||!/^[1-9][0-9]{0,15}$/.test(body.service_id)||!/^[1-9][0-9]{0,15}$/.test(body.vm_id))fail(400,'Provide the SNEL service and VM identifiers')
    if(rows(app,'server_power_profiles','service_id={:service} && vm_id={:vm} && server!={:server}',{service:body.service_id,vm:body.vm_id,server:c.server.id},'',1).length)fail(409,'This SNEL VM is already mapped to another server')
    if(!Number.isInteger(body.boot_port)||body.boot_port<1||body.boot_port>65535)fail(400,'Invalid boot SSH port')
    const bootKey=String(body.boot_host_key||'').trim(),uuid=String(body.luks_uuid||'').toLowerCase()
    if(bootKey.length>8192||/[\r\n\x00]/.test(bootKey)||(bootKey&&!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+$/.test(bootKey)))fail(400,'Provide the verified boot SSH public key')
    if(uuid&&!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(uuid))fail(400,'Invalid LUKS identifier')
    if(!!bootKey!==!!uuid)fail(400,'Provide both the boot SSH key and LUKS identifier')
    const record=p||new Record(app.findCollectionByNameOrId('server_power_profiles'))
    for(const [key,value]of Object.entries({organization:c.org,server:c.server.id,service_id:body.service_id,vm_id:body.vm_id,credential_binding:configured.credential_binding,boot_port:body.boot_port,boot_host_key:bootKey,luks_uuid:uuid,version:(p?p.getInt('version'):0)+1}))record.set(key,value)
    app.save(record);result={id:record.id};return
  }
  if(operation==='begin'){
    if(!actions.includes(body.action)||typeof body.request_id!=='string'||!/^[a-f0-9-]{32,36}$/.test(body.request_id))fail(400,'Invalid operation')
    const existing=rows(app,'server_power_jobs','organization={:org} && user={:user} && request_id={:request}',{org:c.org,user:c.user.id,request:body.request_id},'',1)[0]
    if(existing){if(existing.getString('server')!==c.server.id||existing.getString('action')!==body.action)fail(409,'Operation identity conflict');result={...dto(existing),replayed:true};return}
    const selected=target(app,c);if(selected.version!==body.version)fail(409,'Server settings changed; reload before acting')
    for(const job of rows(app,'server_power_jobs','provider_key={:key} && (status="running" || status="unknown")',{key:providerKey(selected)})){refresh(app,job);if(['running','unknown'].includes(job.getString('status'))&&body.action!=='inspect')fail(409,'An operation is running or needs reconciliation')}
    const job=new Record(app.findCollectionByNameOrId('server_power_jobs'))
    for(const [key,value]of Object.entries({organization:c.org,server:c.server.id,user:c.user.id,request_id:body.request_id,action:body.action,status:body.action==='inspect'?'inspecting':'running',stage:'checking_provider',binding:binding(selected),provider_key:providerKey(selected),target:selected,started_at:new Date().toISOString()}))job.set(key,value)
    app.save(job);result={...dto(job),target:selected,replayed:false};return
  }
  const job=app.findRecordById('server_power_jobs',e.request.pathValue('job'))
  if(job.getString('organization')!==c.org||(job.getString('server')!==c.server.id&&!(operation==='reconcile'&&job.getString('provider_key')===providerKey(target(app,c)))))fail(404,'Operation not found')
  if(operation==='reconcile'){
    refresh(app,job);if(job.getString('status')!=='unknown'||body.inspected_console!==true)fail(409,'Review the provider console before reconciling')
    job.set('status','reconciled');job.set('reason','');job.set('reconciled_by',c.user.id);job.set('finished_at',new Date().toISOString());app.save(job);result=dto(job);return
  }
  if(job.getString('user')!==c.user.id)fail(403,'Only the requesting operator can update this operation')
  if(!['running','inspecting'].includes(job.getString('status')))fail(409,'Operation is no longer running')
  if(binding(target(app,c))!==job.getString('binding'))fail(409,'Operation target changed')
  if(!stages.includes(body.stage)||!reasons.includes(body.reason||'')||Object.keys(body).some(k=>!['stage','reason','status'].includes(k)))fail(400,'Invalid operation result')
  job.set('stage',body.stage);job.set('reason',body.reason||'')
  if(operation==='finish'){
    const allowed=job.getString('action')==='inspect'?['observed','failed']:job.getString('action')==='shutdown'?['powered_off','unknown','failed']:['awaiting_agent','requires_console','unknown','failed']
    if(!allowed.includes(body.status))fail(400,'Invalid action result')
    const pairs={observed:['provider_on','provider_off'],powered_off:['powered_off'],unknown:['unknown'],failed:['failed'],requires_console:['requires_console'],awaiting_agent:['awaiting_agent']}
    if(!pairs[body.status].includes(body.stage))fail(400,'Result stage does not match the action outcome')
    job.set('status',body.status);if(body.status!=='awaiting_agent')job.set('finished_at',new Date().toISOString())
  }
  app.save(job);refresh(app,job);result={...dto(job),authorized:true}
});e.response.header().set('Cache-Control','no-store');return e.json(operation==='begin'?201:200,result)}
module.exports={handle,contact,binding}
