function engine() { return require(__hooks + '/lib/alerts.js') }
function options(body) {
  const lib=engine(), source=body || {}
  if(typeof source!=='object' || Array.isArray(source) || Object.keys(source).some(key=>!['reminder_overrides','exclusions','no_communication_seconds'].includes(key))) throw new Error('Invalid migration options')
  const overrides=source.reminder_overrides || {'host.cpu_percent':{warning:1800,critical:1800},'host.disk_percent':{warning:1800,critical:300}}
  if(typeof overrides!=='object' || Array.isArray(overrides)) throw new Error('Invalid reminder overrides')
  for(const metric of Object.keys(overrides)) {
    if(!lib.catalog().some(item=>item.id===metric)) throw new Error('Invalid reminder metric')
    const intervals=overrides[metric]
    if(!intervals || typeof intervals!=='object' || Array.isArray(intervals) || !Object.keys(intervals).length || Object.keys(intervals).some(key=>!['info','warning','critical'].includes(key) || !Number.isInteger(intervals[key]) || intervals[key]<60 || intervals[key]>604800)) throw new Error('Invalid reminder override')
  }
  const excluded=source.exclusions || []
  if(!Array.isArray(excluded) || excluded.length>10000) throw new Error('Invalid migration exclusions')
  for(const item of excluded) if(!item || !lib.catalog().some(metric=>metric.id===item.metric && metric.target_type===item.resource_type) || typeof item.resource_id!=='string' || !item.resource_id || typeof item.reason!=='string' || !item.reason.trim()) throw new Error('Invalid migration exclusion')
  const threshold=source.no_communication_seconds===undefined?900:source.no_communication_seconds
  if(!Number.isInteger(threshold) || threshold<60 || threshold>604800) throw new Error('Invalid communication threshold')
  return {reminder_overrides:overrides,exclusions:excluded,no_communication_seconds:threshold}
}
function preview(app, org, body) {
  const lib=engine(), settings=options(body), all=lib.rows(app,'alert_rules','organization={:org}',{org}).sort((a,b)=>a.id.localeCompare(b.id))
  const legacy=all.filter(rule=>!lib.boolean(rule,'archived') && lib.number(rule,'model_version')!==2)
  const inventory=lib.inventory(app,org), groups=[], conflicts=[]
  for(const old of legacy) {
    const condition=lib.json(old,'condition'), type=lib.string(old,'target_type'), severity=lib.string(old,'severity'), duration=lib.number(old,'duration_seconds'), enabled=lib.boolean(old,'enabled')
    const identity=lib.canonical({condition,type,severity,duration,enabled})
    let group=groups.find(group=>group.identity===identity)
    if(!group) {group={identity,type,condition,severity,duration,enabled,old:[]};groups.push(group)}
    group.old.push(old)
  }
  if(!all.some(rule=>!lib.boolean(rule,'archived') && lib.json(rule,'condition').metric==='server.no_communication_seconds')) groups.push({identity:'communication',type:'server',condition:{metric:'server.no_communication_seconds',operator:'gte',value:settings.no_communication_seconds},severity:'critical',duration:0,enabled:true,old:[]})
  const items=groups.map(group=>{
    const metric=group.condition.metric, prior=group.old, reminders=[...new Set(prior.map(rule=>lib.number(rule,'reminder_seconds')))]
    const bands=group.condition.critical_value===undefined?[group.severity]:['warning','critical']
    const override=settings.reminder_overrides[metric]
    if(!override && reminders.length>1) conflicts.push({metric,reason:'Different reminder intervals require an explicit override'})
    const intervals={};for(const band of bands) intervals[band]=override && override[band]!==undefined?override[band]:reminders[0] || 1800
    const key='type-'+group.type+'-'+metric.replace(/[^a-zA-Z0-9]+/g,'-')+(metric==='host.disk_percent' && group.condition.disk_path!=='*'?'-'+String(group.condition.disk_path).replace(/[^a-zA-Z0-9]+/g,'-'):'')
    if(all.some(rule=>lib.string(rule,'key')===key)) conflicts.push({metric,reason:'Destination rule key already exists',key})
    const excluded=settings.exclusions.filter(item=>item.metric===metric).map(item=>({resource_type:item.resource_type,resource_id:item.resource_id,reason:item.reason}))
    const declaration={model_version:2,name:prior.length?lib.string(prior[0],'name'):'No communication',target_type:group.type,condition:group.condition,severity:group.severity,duration_seconds:group.duration,reminder_intervals:intervals,enabled:group.enabled,exclusions:excluded}
    lib.normalizeRule(declaration)
    for(const item of excluded) if(!inventory.some(target=>target.resource_type===item.resource_type && target.resource_id===item.resource_id)) throw new Error('Excluded resource does not belong to this organization')
    const targets=inventory.filter(target=>target.resource_type===group.type)
    const previous=targets.filter(target=>prior.some(rule=>lib.matches(rule,target)))
    const incidents=prior.flatMap(rule=>lib.ruleIncidents(app,rule))
    const duplicates=new Set()
    for(const incident of incidents) {const id=lib.string(incident,'resource_type')+':'+lib.string(incident,'resource_id');if(duplicates.has(id)) conflicts.push({metric,reason:'Overlapping open incidents require reconciliation',resource:id});duplicates.add(id)}
    return {key,rule:declaration,source_rules:prior.map(rule=>({id:rule.id,key:lib.string(rule,'key'),edit_version:lib.number(rule,'edit_version'),enabled:lib.boolean(rule,'enabled'),condition:lib.json(rule,'condition'),duration_seconds:lib.number(rule,'duration_seconds'),reminder_seconds:lib.number(rule,'reminder_seconds'),activated_at:lib.string(rule,'activated_at')})),coverage:{total:targets.length,previous:previous.length,new_resources:targets.filter(target=>!previous.includes(target)).map(target=>({resource_type:target.resource_type,resource_id:target.resource_id,resource_name:target.resource_name})),excluded:excluded.length},open_incidents:incidents.map(incident=>({id:incident.id,resource_id:lib.string(incident,'resource_id'),severity:lib.string(incident,'severity'),assignee:lib.string(incident,'assignee'),claim_until:lib.string(incident,'claim_until')}))}
  })
  for(const item of items) if(items.filter(other=>other.rule.target_type===item.rule.target_type && other.rule.condition.metric===item.rule.condition.metric && (other.rule.condition.disk_path || '')===(item.rule.condition.disk_path || '')).length>1) conflicts.push({metric:item.rule.condition.metric,reason:'Divergent conditions or enabled states must be reconciled'})
  for(const exclusion of settings.exclusions) if(!items.some(item=>item.rule.condition.metric===exclusion.metric)) conflicts.push({metric:exclusion.metric,reason:'Exclusion has no migrating condition'})
  const signature={options:settings,rules:items.map(item=>({key:item.key,rule:item.rule,source_rules:item.source_rules})),inventory:inventory.map(target=>({type:target.resource_type,id:target.resource_id,server:target.server_id,workspace:target.workspace_id})).sort((a,b)=>(a.type+a.id).localeCompare(b.type+b.id)),current_rules:all.map(rule=>({id:rule.id,version:lib.number(rule,'edit_version'),archived:lib.boolean(rule,'archived')})).sort((a,b)=>a.id.localeCompare(b.id))}
  return {options:settings,items,conflicts,can_apply:conflicts.length===0 && legacy.length>0,source_count:legacy.length,destination_count:items.length,signature}
}
function apply(app, org, plan, actor, now) {
  const lib=engine(), result={source_count:plan.source_count,destination_count:plan.destination_count,rules:[],incidents_preserved:[],incidents_excluded:[]}
  if(!plan.can_apply) lib.conflict('Migration has conflicts or no legacy rules')
  for(const item of plan.items) {
    const target=lib.saveRule(app,org,item.key,Object.assign({},item.rule,{exclusions:[]}),actor,now)
    const sourceIds=new Set(item.source_rules.map(rule=>rule.id))
    const prior=item.source_rules.map(rule=>app.findRecordById('alert_rules',rule.id))
    const activation=item.source_rules.length?Math.min(...item.source_rules.map(rule=>lib.time(rule.activated_at) || now)):now
    target.set('activated_at',lib.iso(activation));app.save(target)
    const oldStates=prior.flatMap(rule=>lib.states(app,rule)), inventory=lib.inventory(app,org).filter(resource=>resource.resource_type===item.rule.target_type)
    for(const resource of inventory) {
      const candidates=oldStates.filter(state=>lib.string(state,'resource_type')===resource.resource_type && lib.string(state,'resource_id')===resource.resource_id).sort((a,b)=>(lib.json(b,'data').last_raw || 0)-(lib.json(a,'data').last_raw || 0))
      if(candidates.length) {const state=candidates[0],data=lib.json(state,'data');data.revision=lib.number(target,'revision');state.set('rule',target.id);state.set('data',data);app.save(state)}
      else if(item.rule.condition.metric!=='server.no_communication_seconds') {const state=lib.stateFor(app,target,resource);state.set('data',{revision:lib.number(target,'revision'),activated_at:now});app.save(state)}
    }
    const open=lib.rows(app,'incidents','organization={:org} && status="open"',{org}).filter(incident=>sourceIds.has(lib.string(incident,'rule')))
    for(const incident of open) {
      const oldRule=lib.string(incident,'rule'), interval=lib.reminderInterval(target,lib.string(incident,'severity'))
      lib.invalidate(app,incident)
      lib.assign(incident,{rule:target.id,rule_revision:lib.number(target,'revision'),reminder_seconds:interval,next_reminder_at:lib.iso(Math.max(now+interval*1000,lib.time(lib.string(incident,'claim_until')) || 0)),schedule_generation:lib.number(incident,'schedule_generation')+1,version:lib.number(incident,'version')+1})
      app.save(incident);lib.audit(app,incident,'rule_migrated',actor,{from_rule:oldRule,to_rule:target.id},now)
      result.incidents_preserved.push(incident.id)
    }
    lib.setExclusions(app,target,item.rule.exclusions,actor,now)
    for(const incident of open) if(item.rule.exclusions.some(exclusion=>exclusion.resource_type===lib.string(incident,'resource_type') && exclusion.resource_id===lib.string(incident,'resource_id'))) result.incidents_excluded.push(incident.id)
    for(const old of prior) {lib.assign(old,{archived:true,enabled:false,edit_version:lib.number(old,'edit_version')+1});app.save(old)}
    lib.ruleAudit(app,target,'legacy_migrated',actor,{source_rules:item.source_rules.map(rule=>rule.id)},now)
    result.rules.push({id:target.id,key:item.key,source_ids:[...sourceIds]})
  }
  result.incidents_preserved=result.incidents_preserved.filter(id=>!result.incidents_excluded.includes(id))
  return result
}
module.exports={options,preview,apply}
