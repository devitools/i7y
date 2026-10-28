migrate((app) => {
  const operators = new Collection({
    type:'auth', name:'operators',
    listRule:null, viewRule:'id = @request.auth.id',
    createRule:null, updateRule:null, deleteRule:null,
    fields:[{type:'select', name:'role', required:true, maxSelect:1, values:['viewer','editor']}],
    passwordAuth:{enabled:true, identityFields:['email']},
  })
  app.save(operators)
  const editor = '@request.auth.collectionName = "operators" && @request.auth.role = "editor"'
  for (const name of ['workspaces','servers','projects','containers']) {
    const collection = app.findCollectionByNameOrId(name)
    collection.createRule = editor
    collection.updateRule = editor
    collection.deleteRule = editor
    app.save(collection)
  }
}, (app) => {
  for (const name of ['workspaces','servers','projects','containers']) {
    const collection = app.findCollectionByNameOrId(name)
    collection.createRule = null
    collection.updateRule = null
    collection.deleteRule = null
    app.save(collection)
  }
  app.delete(app.findCollectionByNameOrId('operators'))
})
