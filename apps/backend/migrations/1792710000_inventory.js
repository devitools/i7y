migrate((app) => {
  const collection = new Collection({
    type: 'base', name: 'workspaces',
    listRule: '', viewRule: '', createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { type: 'text', name: 'login', required: true },
      { type: 'json', name: 'snapshot', required: true, maxSize: 10000000 },
    ],
    indexes: ['CREATE UNIQUE INDEX idx_workspace_login ON workspaces (login)'],
  })
  app.save(collection)
}, (app) => app.delete(app.findCollectionByNameOrId('workspaces')))
