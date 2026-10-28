migrate((app) => {
  const users = app.findCollectionByNameOrId('users')
  users.listRule = 'id = @request.auth.id'
  users.viewRule = 'id = @request.auth.id'
  users.createRule = null
  users.updateRule = 'id = @request.auth.id'
  users.deleteRule = null
  app.save(users)
  for (const source of ['operators','_superusers']) {
    app.db().newQuery(`
      INSERT INTO users (id, email, emailVisibility, password, tokenKey, verified, created, updated)
      SELECT id, email, emailVisibility, password, tokenKey, verified,
        strftime('%Y-%m-%d %H:%M:%fZ', 'now'), strftime('%Y-%m-%d %H:%M:%fZ', 'now')
      FROM ${source}
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.email = ${source}.email)
    `).execute()
  }
  for (const name of ['workspaces','servers','projects','containers']) {
    const collection = app.findCollectionByNameOrId(name)
    collection.createRule = '@request.auth.collectionName = "users"'
    collection.updateRule = '@request.auth.collectionName = "users"'
    collection.deleteRule = '@request.auth.collectionName = "users"'
    app.save(collection)
  }
  app.delete(app.findCollectionByNameOrId('operators'))
}, (app) => {
  app.save(new Collection({
    type:'auth', name:'operators',
    listRule:null, viewRule:'id = @request.auth.id',
    createRule:null, updateRule:null, deleteRule:null,
    fields:[{type:'select',name:'role',required:true,maxSelect:1,values:['viewer','editor']}],
    passwordAuth:{enabled:true,identityFields:['email']},
  }))
  app.db().newQuery(`
    INSERT INTO operators (id,email,emailVisibility,password,tokenKey,verified,role)
    SELECT id,email,emailVisibility,password,tokenKey,verified,'editor' FROM users
  `).execute()
  for (const name of ['workspaces','servers','projects','containers']) {
    const collection = app.findCollectionByNameOrId(name)
    collection.createRule = '@request.auth.collectionName = "operators" && @request.auth.role = "editor"'
    collection.updateRule = collection.createRule
    collection.deleteRule = collection.createRule
    app.save(collection)
  }
})
