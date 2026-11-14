migrate(app=>{
  const collection=app.findCollectionByNameOrId('server_power_profiles')
  collection.fields.add(new TextField({name:'credential_binding',max:64}))
  app.save(collection)
},app=>{
  const collection=app.findCollectionByNameOrId('server_power_profiles')
  collection.fields.removeByName('credential_binding')
  app.save(collection)
})
