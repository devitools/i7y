onBootstrap((e) => {
  e.next()
  e.app.runAllMigrations()
  let replace = false
  try { $os.stat('/pb/pb_data/inventory-sync'); replace = true } catch (_) {}
  if (!replace) {
    try { $os.stat('/pb/pb_data/inventory-initialized'); return } catch (_) {}
    if (e.app.findAllRecords('workspaces').length) {
      $os.writeFile('/pb/pb_data/inventory-initialized', '1', 0o600)
      return
    }
  }
  const inventoryFile = $os.getenv('INVENTORY_FILE')
  if (!inventoryFile) return
  const data = JSON.parse(toString($os.readFile(inventoryFile)))
  if (!Array.isArray(data)) throw new Error('Inventory must be an array of workspaces.')
  const seen = new Set()
  for (const workspace of data) {
    if (!workspace.login || !Array.isArray(workspace.services) || seen.has(workspace.login)) throw new Error('Invalid or duplicate workspace.')
    seen.add(workspace.login)
  }
  e.app.runInTransaction((app) => {
    const initial=app.findFirstRecordByFilter('organizations','initial=true')
    const organizations={}
    for(const r of app.findAllRecords('workspaces'))organizations[r.getString('login')]=r.getString('organization')
    const collections = {}
    for (const name of ['containers','projects','servers','workspaces']) {
      collections[name] = app.findCollectionByNameOrId(name)
      for (const record of app.findAllRecords(collections[name])) app.delete(record)
    }
    const save = (table, values) => {
      const record = new Record(collections[table])
      for (const key in values) record.set(key, values[key])
      app.save(record)
      return record.id
    }
    for (const workspace of data) {
      const wid = save('workspaces', {organization:organizations[workspace.login] || initial.id,login:workspace.login,provider:workspace.provider,query:workspace.query,credential:workspace.credential})
      workspace.services.forEach((server, si) => {
        const sid = save('servers', {workspace:wid,type:server.type,product:server.product,name:server.name,ip:server.ip,status:server.status,credential:server.credential,inventory_known:Array.isArray(server.projects),sort_order:si})
        ;(server.projects || []).forEach((project, pi) => {
          const pid = save('projects', {server:sid,name:project.name,path:project.path,sort_order:pi})
          project.containers.forEach((container, ci) => save('containers', {project:pid,name:container.name,image:container.image,sort_order:ci}))
        })
      })
    }
  })
  $os.writeFile('/pb/pb_data/inventory-initialized', '1', 0o600)
  if (replace) $os.remove('/pb/pb_data/inventory-sync')
})
