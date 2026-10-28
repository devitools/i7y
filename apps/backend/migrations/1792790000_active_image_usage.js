migrate(app=>{
 const collection=app.findCollectionByNameOrId('i7y_images')
 const active=" WHERE (CASE WHEN json_valid(c.telemetry) THEN coalesce(json_extract(c.telemetry,'$.state'),'unknown') ELSE 'unknown' END) NOT IN ('missing','removed') GROUP BY "
 if(collection.viewQuery.includes(active)) return
 if(collection.viewQuery.includes(' WHERE ')) throw new Error('Review existing image filters before applying active usage')
 collection.viewQuery=collection.viewQuery.split(' GROUP BY ').join(active)
 app.save(collection)
},app=>{
 const collection=app.findCollectionByNameOrId('i7y_images')
 const active=" WHERE (CASE WHEN json_valid(c.telemetry) THEN coalesce(json_extract(c.telemetry,'$.state'),'unknown') ELSE 'unknown' END) NOT IN ('missing','removed') GROUP BY "
 collection.viewQuery=collection.viewQuery.split(active).join(' GROUP BY ')
 app.save(collection)
})
