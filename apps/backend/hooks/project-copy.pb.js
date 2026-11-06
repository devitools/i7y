routerAdd('GET','/api/i7y/project-copy/v1/projects/{id}',e=>{
  const lib=require(__hooks+'/lib/organizations.js')
  const project=e.app.findRecordById('projects',e.request.pathValue('id'))
  const organization=lib.organization(e.app,project)
  lib.requireRole(e,organization,true)
  const server=e.app.findRecordById('servers',project.getString('server'))
  return e.json(200,{id:project.id,organization,address:server.getString('ip'),source_path:project.getString('path'),source_domain:project.getString('name')})
},$apis.requireAuth('users'))
