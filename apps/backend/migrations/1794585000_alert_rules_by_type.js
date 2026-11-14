migrate(app => {
  const rules = app.findCollectionByNameOrId('alert_rules')
  rules.fields.getByName('scope_type').values = ['workspace', 'server', 'container', 'organization']
  rules.fields.getByName('scope_id').required = false
  rules.fields.add(new NumberField({name:'model_version', min:0, onlyInt:true}))
  rules.fields.add(new JSONField({name:'reminder_intervals', maxSize:2048}))
  rules.fields.add(new TextField({name:'condition_key', max:8192}))
  rules.indexes.push('CREATE UNIQUE INDEX idx_alert_type_condition ON alert_rules (organization,condition_key) WHERE model_version = 2 AND archived = 0')
  app.save(rules)
  const relation = (name, target, required=true) => ({type:'relation', name, collectionId:app.findCollectionByNameOrId(target).id, maxSelect:1, required, cascadeDelete:false})
  const text = (name, max=240, required=false) => ({type:'text',name,max,required})
  const create = (name, fields, indexes=[]) => app.save(new Collection({name,type:'base',listRule:null,viewRule:null,createRule:null,updateRule:null,deleteRule:null,fields:[relation('organization','organizations'),...fields,{type:'autodate',name:'created',onCreate:true}],indexes}))
  create('alert_rule_exclusions',[relation('rule','alert_rules'),text('resource_type',32,true),text('resource_id',15,true),text('resource_name',512),text('reason',1024,true),text('actor',240)],['CREATE UNIQUE INDEX idx_alert_rule_exclusion ON alert_rule_exclusions (rule,resource_type,resource_id)'])
  create('alert_rule_events',[relation('rule','alert_rules'),text('kind',64,true),text('actor',240),{type:'date',name:'occurred_at'},{type:'json',name:'data',maxSize:262144}],['CREATE INDEX idx_alert_rule_event ON alert_rule_events (rule,occurred_at)'])
  create('alert_rule_migrations',[text('plan_hash',64,true),text('actor',240),{type:'date',name:'applied_at'},{type:'json',name:'result',maxSize:4194304}],['CREATE UNIQUE INDEX idx_alert_rule_migration ON alert_rule_migrations (organization,plan_hash)'])
}, app => {
  if(app.findRecordsByFilter('alert_rules','model_version=2','',1).length) throw new Error('Restore a compatible backup before removing the type-rule schema')
  for(const name of ['alert_rule_migrations','alert_rule_events','alert_rule_exclusions']) app.delete(app.findCollectionByNameOrId(name))
  const rules=app.findCollectionByNameOrId('alert_rules')
  rules.indexes=rules.indexes.filter(index=>!index.includes('idx_alert_type_condition'))
  for(const name of ['model_version','reminder_intervals','condition_key']) rules.fields.removeByName(name)
  rules.fields.getByName('scope_type').values=['workspace','server','container']
  rules.fields.getByName('scope_id').required=true
  app.save(rules)
})
