migrate(app=>{
  const collection=app.findCollectionByNameOrId('i7y_servers')
  collection.viewQuery=collection.viewQuery.replace(/^SELECT /,"SELECT (CASE WHEN s.type='VPS' THEN 0 ELSE 1 END) AS type_order,")
  app.save(collection)
},app=>{
  const collection=app.findCollectionByNameOrId('i7y_servers')
  collection.viewQuery=collection.viewQuery.replace("(CASE WHEN s.type='VPS' THEN 0 ELSE 1 END) AS type_order,",'')
  app.save(collection)
})
