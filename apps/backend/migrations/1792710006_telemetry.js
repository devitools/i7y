migrate((app) => {
  const relation = (name, collection) => ({type:'relation',name,collectionId:app.findCollectionByNameOrId(collection).id,required:true,maxSelect:1,cascadeDelete:true})
  for (const name of ['servers','projects','containers']) {
    const c = app.findCollectionByNameOrId(name)
    c.fields.add(new JSONField({name:'telemetry'}))
    c.fields.add(new DateField({name:'last_seen'}))
    app.save(c)
  }
  const rule = '@request.auth.collectionName = "users"'
  app.save(new Collection({name:'server_agents',type:'base',listRule:rule,viewRule:rule,fields:[relation('server','servers'),{type:'text',name:'token_hash',required:true,hidden:true},{type:'text',name:'prefix'},{type:'autodate',name:'created',onCreate:true}],indexes:['CREATE UNIQUE INDEX idx_agent_hash ON server_agents (token_hash)','CREATE UNIQUE INDEX idx_agent_server ON server_agents (server)']}))
  app.save(new Collection({name:'telemetry_samples',type:'base',listRule:rule,viewRule:rule,fields:[relation('server','servers'),{type:'text',name:'sample_id',required:true},{type:'date',name:'observed_at',required:true},{type:'date',name:'received_at',required:true},{type:'json',name:'payload',required:true}],indexes:['CREATE UNIQUE INDEX idx_sample_identity ON telemetry_samples (server,sample_id)','CREATE INDEX idx_sample_time ON telemetry_samples (server,observed_at)']}))
}, (app) => {
  app.delete(app.findCollectionByNameOrId('telemetry_samples'))
  app.delete(app.findCollectionByNameOrId('server_agents'))
  for (const name of ['servers','projects','containers']) {
    const c=app.findCollectionByNameOrId(name)
    c.fields.removeByName('telemetry'); c.fields.removeByName('last_seen'); app.save(c)
  }
})
