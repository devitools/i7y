function fail(status,message) {throw new ApiError(status,message)}
function handle(e,operation) {
  const lib=require(__hooks+'/lib/alerts.js'), http=require(__hooks+'/lib/alerts-http.js'), migration=require(__hooks+'/lib/alerts-migration.js')
  const write=['save','archive','migration-apply'].includes(operation)
  let result
  try {e.app.runInTransaction(app=>{
    const p=http.permission(e,app,'alerts:'+(write?'write':'read'),write,operation==='migration-apply')
    const body=e.requestInfo().body || {}, key=e.request.pathValue('key'), now=Date.now()
    const request=e.request.header.get('X-I7y-MCP-Request')
    let binding=''
    if(write && request) {
      if(e.get('i7yApiToken') || !/^[a-f0-9]{32}$/.test(request)) fail(403,'Invalid desktop MCP request')
      binding=$security.sha256(http.canonical({operation,path:e.request.url.path,body,revision:e.request.header.get('X-I7y-Expected-Revision')}))
      const receipt=lib.rows(app,'mcp_receipts','organization={:org} && user={:user} && request_id={:id}',{org:p.org,user:p.user.id,id:request})[0]
      if(receipt) {if(lib.string(receipt,'binding')!==binding) fail(409,'Request identity conflict');result=lib.json(receipt,'result');return}
    }
    const declaration=record=>Object.assign(http.dto(record,'alert_rules'),lib.describeRule(app,record))
    const rule=()=>{
      const record=lib.rows(app,'alert_rules','organization={:org} && key={:key} && archived=false',{org:p.org,key})[0]
      if(!record) fail(404,'Rule not found')
      return record
    }
    const validate=()=>{
      const raw=Object.assign({},body,{model_version:2}), normalized=lib.normalizeRule(raw)
      const existing=lib.rows(app,'alert_rules','organization={:org} && key={:key}',{org:p.org,key})[0], prior=existing?lib.exclusions(app,existing):[]
      for(const item of normalized.exclusions) if(!prior.some(before=>before.resource_type===item.resource_type && before.resource_id===item.resource_id)) http.inventoryContext(app,item.resource_type,item.resource_id,p.org)
      return raw
    }
    if(operation==='metrics') result={items:lib.catalog(),capabilities:{rule_model_version:2,type_coverage:true,exclusions:true,severity_reminders:true,migration:true}}
    else if(operation==='list') {
      result=http.listing(e,app,'alert_rules',p.org)
      result.items=result.items.map(item=>declaration(app.findRecordById('alert_rules',item.id)))
    } else if(operation==='get') result=declaration(rule())
    else if(operation==='simulate') {
      result=lib.simulate(app,p.org,validate())
      const page=http.positiveInteger(e.request.url.query().get('page'),1,1000000), perPage=http.positiveInteger(e.request.url.query().get('perPage'),100,100)
      result=Object.assign({},result,{items:result.items.slice((page-1)*perPage,page*perPage),page,perPage,totalPages:Math.ceil(result.totalItems/perPage)})
    } else if(operation==='save' || operation==='archive') {
      if(typeof key!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(key)) fail(400,'Invalid rule key')
      const expected=e.request.header.get('X-I7y-Expected-Revision')
      if(!/^\d+$/.test(expected)) fail(400,'Provide the expected rule edit_version')
      const prior=lib.rows(app,'alert_rules','organization={:org} && key={:key}',{org:p.org,key})[0]
      if(Number(expected)!==(prior?lib.number(prior,'edit_version'):0)) fail(409,'Rule changed; reload before editing')
      if(prior && lib.number(prior,'model_version')!==2) fail(409,'Migrate this legacy rule before editing')
      if(operation==='save') {
        if(lib.rows(app,'alert_rules','organization={:org} && archived=false',{org:p.org}).some(record=>lib.number(record,'model_version')!==2)) fail(409,'Review and migrate legacy rules before creating type rules')
        result=declaration(lib.saveRule(app,p.org,key,validate(),p.user.id,now))
      }
      else {if(!prior) fail(404,'Rule not found');lib.archiveRule(app,prior,p.user.id,now);result={archived:true}}
    } else if(operation==='migration-preview' || operation==='migration-apply') {
      if(operation==='migration-apply') {
        const previous=lib.rows(app,'alert_rule_migrations','organization={:org} && plan_hash={:hash}',{org:p.org,hash:body.plan_hash || ''})[0]
        if(previous) {result=lib.json(previous,'result');if(write && request)lib.create(app,'mcp_receipts',{organization:p.org,user:p.user.id,request_id:request,binding,result});return}
      }
      const plan=migration.preview(app,p.org,body.options)
      const hash=$security.sha256(lib.canonical(plan.signature));delete plan.signature
      if(operation==='migration-preview') result=Object.assign(plan,{plan_hash:hash})
      else {
        if(!/^[a-f0-9]{64}$/.test(body.plan_hash || '') || body.plan_hash!==hash) fail(409,'Migration changed; review a new preview')
        result=migration.apply(app,p.org,plan,p.user.id,now)
        const receipt=lib.create(app,'alert_rule_migrations',{organization:p.org,plan_hash:hash,actor:p.user.id,applied_at:lib.iso(now),result})
        result=Object.assign(result,{id:receipt.id,plan_hash:hash,applied_at:lib.iso(now)})
        receipt.set('result',result);app.save(receipt)
      }
    } else fail(404,'Unknown alert operation')
    if(write && request) lib.create(app,'mcp_receipts',{organization:p.org,user:p.user.id,request_id:request,binding,result})
  })} catch(error) {
    if(error.status || error.statusCode) throw error
    fail(Number(error.code)===409?409:400,String(error.message || 'Invalid request'))
  }
  return operation==='archive'?e.noContent(204):e.json(200,result)
}
module.exports={handle}
