migrate((app) => {
  const workspace = app.findCollectionByNameOrId('workspaces')
  workspace.fields.removeByName('snapshot')
  workspace.fields.add(new TextField({name:'provider'}))
  workspace.fields.add(new TextField({name:'query'}))
  workspace.fields.add(new JSONField({name:'credential'}))
  app.save(workspace)
  const create = (name, fields) => {
    const collection = new Collection({type:'base',name,listRule:'',viewRule:'',createRule:null,updateRule:null,deleteRule:null,fields})
    app.save(collection)
    return collection
  }
  const relation = (name, collection) => ({type:'relation',name,collectionId:collection.id,maxSelect:1,required:true,cascadeDelete:true})
  const text = name => ({type:'text',name})
  const servers = create('servers', [relation('workspace',workspace), ...['type','product','name','ip','status'].map(text), {type:'json',name:'credential'}, {type:'bool',name:'inventory_known'}, {type:'number',name:'sort_order'}])
  const projects = create('projects', [relation('server',servers),text('name'),text('path'),{type:'number',name:'sort_order'}])
  create('containers', [relation('project',projects),text('name'),text('image'),{type:'number',name:'sort_order'}])
}, (app) => {
  for (const name of ['containers','projects','servers']) app.delete(app.findCollectionByNameOrId(name))
})
