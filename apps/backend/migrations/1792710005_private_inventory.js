migrate((app) => {
  for (const name of ['workspaces','servers','projects','containers']) {
    const collection = app.findCollectionByNameOrId(name)
    collection.listRule = '@request.auth.collectionName = "users"'
    collection.viewRule = '@request.auth.collectionName = "users"'
    app.save(collection)
  }
}, (app) => {
  for (const name of ['workspaces','servers','projects','containers']) {
    const collection = app.findCollectionByNameOrId(name)
    collection.listRule = ''
    collection.viewRule = ''
    app.save(collection)
  }
})
