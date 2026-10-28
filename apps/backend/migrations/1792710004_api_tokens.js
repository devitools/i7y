migrate((app) => {
  app.save(new Collection({
    type:'base', name:'api_tokens',
    listRule:null, viewRule:null, createRule:null, updateRule:null, deleteRule:null,
    fields:[
      {type:'relation',name:'user',collectionId:app.findCollectionByNameOrId('users').id,required:true,maxSelect:1,cascadeDelete:true},
      {type:'text',name:'label',required:true,max:80},
      {type:'text',name:'token_hash',required:true,hidden:true},
      {type:'text',name:'prefix',required:true},
      {type:'select',name:'scope',required:true,maxSelect:1,values:['read','write']},
      {type:'date',name:'expires_at',required:true},
      {type:'autodate',name:'created',onCreate:true,onUpdate:false},
    ],
    indexes:['CREATE UNIQUE INDEX idx_api_token_hash ON api_tokens (token_hash)'],
  }))
}, (app) => app.delete(app.findCollectionByNameOrId('api_tokens')))
