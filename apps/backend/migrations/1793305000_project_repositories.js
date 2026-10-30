migrate(app => {
  const projects = app.findCollectionByNameOrId('projects')
  projects.fields.add(new TextField({name:'source_repository_url',max:2048,pattern:'^https?://[^/@\\s?#]+(/[^\\s?#]*)?$'}))
  projects.fields.add(new TextField({name:'deployment_branch',max:255}))
  projects.fields.add(new TextField({name:'deployment_template',max:1024}))
  projects.fields.add(new SelectField({name:'version_control_status',maxSelect:1,values:['unknown','versioned','unversioned']}))
  app.save(projects)
  app.db().newQuery("UPDATE projects SET version_control_status='unknown' WHERE version_control_status=''").execute()
  const view = app.findCollectionByNameOrId('i7y_projects')
  const payload = "'path',p.path,"
  const search = "(p.name || ' ' || p.path || ' ' || s.name"
  if (!view.viewQuery.includes(payload) || !view.viewQuery.includes(search)) throw new Error('Unexpected project inventory view')
  view.viewQuery = view.viewQuery
    .replace(payload,payload + "'source_repository_url',p.source_repository_url,'deployment_branch',p.deployment_branch,'deployment_template',p.deployment_template,'version_control_status',coalesce(nullif(p.version_control_status,''),'unknown'),")
    .replace(search,"(p.name || ' ' || p.path || ' ' || p.source_repository_url || ' ' || p.deployment_branch || ' ' || p.deployment_template || ' ' || s.name")
  app.save(view)
}, app => {
  const view = app.findCollectionByNameOrId('i7y_projects')
  view.viewQuery = view.viewQuery
    .replace("'source_repository_url',p.source_repository_url,'deployment_branch',p.deployment_branch,'deployment_template',p.deployment_template,'version_control_status',coalesce(nullif(p.version_control_status,''),'unknown'),",'')
    .replace("p.source_repository_url || ' ' || p.deployment_branch || ' ' || p.deployment_template || ' ' || ",'')
  app.save(view)
  const projects = app.findCollectionByNameOrId('projects')
  for (const field of ['source_repository_url','deployment_branch','deployment_template','version_control_status']) projects.fields.removeByName(field)
  app.save(projects)
})
