onRecordDelete(e=>{
  return e.app.runInTransaction(app=>{
    e.app=app
    const type={workspaces:'workspace',servers:'server',projects:'project',containers:'container'}[e.record.collection().name]
    require(__hooks+'/lib/alerts.js').removeTarget(app,type,e.record.id,'resource_removed','system')
    return e.next()
  })
},'workspaces','servers','projects','containers')
