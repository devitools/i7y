migrate(app=>{
  app.save(new Collection({name:'desktop_authorizations',type:'base',listRule:null,viewRule:null,createRule:null,updateRule:null,deleteRule:null,fields:[
    {type:'text',name:'request_hash',required:true,hidden:true},
    {type:'text',name:'challenge',required:true,hidden:true},
    {type:'relation',name:'user',collectionId:app.findCollectionByNameOrId('users').id,required:true,maxSelect:1,cascadeDelete:true},
    {type:'date',name:'expires_at',required:true},
    {type:'bool',name:'consumed'},
  ],indexes:['CREATE UNIQUE INDEX idx_desktop_request ON desktop_authorizations (request_hash)']}))
},app=>app.delete(app.findCollectionByNameOrId('desktop_authorizations')))
