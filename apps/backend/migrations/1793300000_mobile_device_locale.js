migrate(app=>{
  const collection=app.findCollectionByNameOrId('mobile_devices')
  collection.fields.add(new SelectField({name:'locale',values:['en','pt-BR','uk'],maxSelect:1}))
  app.save(collection)
},app=>{
  const collection=app.findCollectionByNameOrId('mobile_devices')
  collection.fields.removeByName('locale')
  app.save(collection)
})
