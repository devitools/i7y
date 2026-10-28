migrate((app)=>{
  const collection=app.findCollectionByNameOrId('i7y_containers')
  collection.viewQuery=collection.viewQuery
    .replace('c.name,c.image,c.sort_order',"c.name,c.image,(CASE WHEN json_valid(c.telemetry) THEN coalesce(json_extract(c.telemetry,'$.state'),'unknown') ELSE 'unknown' END) AS state,c.sort_order")
    .replace("'image',c.image,'project'","'image',c.image,'state',(CASE WHEN json_valid(c.telemetry) THEN coalesce(json_extract(c.telemetry,'$.state'),'unknown') ELSE 'unknown' END),'telemetry',json(CASE WHEN json_valid(c.telemetry) THEN c.telemetry ELSE 'null' END),'project'")
  app.save(collection)
},(app)=>{
  const collection=app.findCollectionByNameOrId('i7y_containers')
  collection.viewQuery=collection.viewQuery
    .replace("(CASE WHEN json_valid(c.telemetry) THEN coalesce(json_extract(c.telemetry,'$.state'),'unknown') ELSE 'unknown' END) AS state,",'')
    .replace("'state',(CASE WHEN json_valid(c.telemetry) THEN coalesce(json_extract(c.telemetry,'$.state'),'unknown') ELSE 'unknown' END),'telemetry',json(CASE WHEN json_valid(c.telemetry) THEN c.telemetry ELSE 'null' END),",'')
  app.save(collection)
})
