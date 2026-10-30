migrate(app=>{
  const collection=app.findCollectionByNameOrId('mobile_devices')
  collection.fields.add(new TextField({name:'time_zone',max:80}))
  app.save(collection)
},app=>{
  const collection=app.findCollectionByNameOrId('mobile_devices')
  collection.fields.removeByName('time_zone')
  app.save(collection)
})
