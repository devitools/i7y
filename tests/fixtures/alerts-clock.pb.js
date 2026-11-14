routerAdd('POST','/test/alerts/tick',e=>{
  e.app.runInTransaction(app=>{
    const body=e.requestInfo().body || {}
    if(body.age_agent) {
      if(!/^[a-z0-9]{15}$/.test(body.age_agent)) throw new BadRequestError('Invalid fixture agent')
      app.db().newQuery('UPDATE server_agents SET created={:created} WHERE id={:id}').bind({created:new Date(Date.now()-3600000).toISOString().replace('T',' '),id:body.age_agent}).execute()
    }
    require(__hooks+'/lib/alerts.js').tick(app,body.now || Date.now())
  })
  return e.json(200,{ok:true})
},$apis.requireAuth('_superusers'))
