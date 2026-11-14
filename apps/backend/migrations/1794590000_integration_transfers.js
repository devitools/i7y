migrate(app=>{
  app.save(new Collection({name:'alert_integration_transfers',type:'base',listRule:null,viewRule:null,createRule:null,updateRule:null,deleteRule:null,fields:[
    {type:'text',name:'integration',max:15,required:true},
    {type:'text',name:'source_organization',max:15,required:true},
    {type:'text',name:'destination_organization',max:15,required:true},
    {type:'text',name:'plan_hash',max:64,required:true},
    {type:'text',name:'actor',max:15,required:true},
    {type:'json',name:'result',maxSize:65536},
    {type:'autodate',name:'created',onCreate:true,onUpdate:false}
  ],indexes:['CREATE UNIQUE INDEX idx_alert_integration_transfer ON alert_integration_transfers (integration,plan_hash)']}))
},app=>app.delete(app.findCollectionByNameOrId('alert_integration_transfers')))
