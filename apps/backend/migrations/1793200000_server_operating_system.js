migrate(app=>{
 const collection=app.findCollectionByNameOrId('i7y_servers')
 const os="coalesce(nullif(json_extract(CASE WHEN json_valid(s.telemetry) THEN s.telemetry ELSE '{}' END,'$.host.operating_system.pretty_name'),''),nullif(trim(coalesce(json_extract(s.telemetry,'$.host.operating_system.name'),'') || ' ' || coalesce(json_extract(s.telemetry,'$.host.operating_system.version_id'),'')),''),'')"
 collection.viewQuery=collection.viewQuery.replace(/^SELECT /,'SELECT '+os+' AS os_name,').replace("s.product || ' ' || coalesce(s.credential","s.product || ' ' || "+os+" || ' ' || coalesce(s.credential")
 app.save(collection)
},app=>{})
