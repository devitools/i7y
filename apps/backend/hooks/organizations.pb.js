onRecordUpdateRequest(e=>{
  if(!e.hasSuperuserAuth() && e.record.getBool('global_admin')!==e.record.original().getBool('global_admin'))throw new ForbiddenError('Global administration cannot be changed')
  return e.next()
},'users')
for(const action of [onRecordCreateRequest,onRecordUpdateRequest,onRecordDeleteRequest]) action(e=>{
  if(e.hasSuperuserAuth())return e.next()
  const lib=require(__hooks+'/lib/organizations.js')
  const org=lib.organization(e.app,e.record)
  lib.requireRole(e,org,true)
  if(e.requestInfo().method==='PATCH' && lib.organization(e.app,e.record.original())!==org)throw new ForbiddenError('Use the workspace transfer endpoint')
  return e.next()
},'workspaces','servers','projects','containers')
routerAdd('GET','/api/i7y/organizations',e=>{
  const lib=require(__hooks+'/lib/organizations.js')
  const rows=e.auth.getBool('global_admin')?e.app.findAllRecords('organizations'):e.app.findRecordsByFilter('organization_memberships','user={:user}','',0,0,{user:e.auth.id}).map(m=>e.app.findRecordById('organizations',m.getString('organization')))
  return e.json(200,{global_admin:e.auth.getBool('global_admin'),items:rows.map(r=>({id:r.id,name:r.getString('name'),role:lib.role(e.app,e.auth,r.id)}))})
},$apis.requireAuth('users'))
routerAdd('POST','/api/i7y/organizations',e=>{
  if(!e.auth.getBool('global_admin'))throw new ForbiddenError('Global administrator required')
  const name=String(e.requestInfo().body.name||'').trim()
  if(!name)throw new BadRequestError('Name required')
  const r=new Record(e.app.findCollectionByNameOrId('organizations'));r.set('name',name);e.app.save(r)
  return e.json(201,{id:r.id,name:r.getString('name'),role:'admin'})
},$apis.requireAuth('users'))
routerAdd('PATCH','/api/i7y/organizations/{org}',e=>{
  require(__hooks+'/lib/organizations.js').requireRole(e,e.request.pathValue('org'),true,true)
  const r=e.app.findRecordById('organizations',e.request.pathValue('org'))
  r.set('name',String(e.requestInfo().body.name||'').trim());e.app.save(r);return e.noContent(204)
},$apis.requireAuth('users'))
routerAdd('DELETE','/api/i7y/organizations/{org}',e=>{
  if(!e.auth.getBool('global_admin'))throw new ForbiddenError('Global administrator required')
  e.app.runInTransaction(app=>{
    const org=e.request.pathValue('org'),r=app.findRecordById('organizations',org)
    if(r.getBool('initial') || app.countRecords('workspaces',$dbx.hashExp({organization:org}))>0)throw new BadRequestError('Organization must be empty and cannot be the initial organization')
    app.delete(r)
  });return e.noContent(204)
},$apis.requireAuth('users'))
routerAdd('GET','/api/i7y/organizations/{org}/members',e=>{
  const org=e.request.pathValue('org')
  require(__hooks+'/lib/organizations.js').requireRole(e,org,true,true)
  return e.json(200,{items:e.app.findRecordsByFilter('organization_memberships','organization={:org}','',0,0,{org}).map(r=>{const u=e.app.findRecordById('users',r.getString('user'));return {id:r.id,email:u.email(),name:u.getString('name'),role:r.getString('role')}})})
},$apis.requireAuth('users'))
for(const method of ['PATCH','DELETE'])routerAdd(method,'/api/i7y/organizations/{org}/members/{id}',e=>{
  const org=e.request.pathValue('org');require(__hooks+'/lib/organizations.js').requireRole(e,org,true,true)
  e.app.runInTransaction(app=>{
    const r=app.findRecordById('organization_memberships',e.request.pathValue('id'))
    if(r.getString('organization')!==org)throw new NotFoundError('Member not found')
    const next=e.requestInfo().method==='DELETE'?'':String(e.requestInfo().body.role||'')
    if(e.requestInfo().method==='PATCH' && !['admin','editor','reader'].includes(next))throw new BadRequestError('Invalid role')
    if(r.getString('role')==='admin' && next!=='admin' && app.findRecordsByFilter('organization_memberships','organization={:org} && role="admin"','',2,0,{org}).length<=1)throw new BadRequestError('Keep at least one administrator')
    if(next){r.set('role',next);app.save(r)}else app.delete(r)
  });return e.noContent(204)
},$apis.requireAuth('users'))
routerAdd('GET','/api/i7y/organizations/{org}/invitations',e=>{
  const org=e.request.pathValue('org');require(__hooks+'/lib/organizations.js').requireRole(e,org,true,true)
  return e.json(200,{items:e.app.findRecordsByFilter('organization_invitations','organization={:org}','',0,0,{org}).map(r=>({id:r.id,email:r.getString('email'),role:r.getString('role'),expires_at:r.getString('expires_at'),used_at:r.getString('used_at'),revoked_at:r.getString('revoked_at')}))})
},$apis.requireAuth('users'))
routerAdd('POST','/api/i7y/organizations/{org}/invitations',e=>{
  const org=e.request.pathValue('org');require(__hooks+'/lib/organizations.js').requireRole(e,org,true,true)
  const b=e.requestInfo().body,email=String(b.email||'').trim().toLowerCase(),role=b.role
  if(!['admin','editor','reader'].includes(role))throw new BadRequestError('Invalid role')
  const secret='i7yi_'+$security.randomString(64)
  e.app.runInTransaction(app=>{
    const existing=app.findRecordsByFilter('organization_memberships','organization={:org} && user.email={:email}','',1,0,{org,email})
    if(existing.length)throw new BadRequestError('Person is already a member; edit their role instead')
    for(const old of app.findRecordsByFilter('organization_invitations','organization={:org} && email={:email} && used_at="" && revoked_at=""','',0,0,{org,email})){old.set('revoked_at',new Date().toISOString());app.save(old)}
    const r=new Record(app.findCollectionByNameOrId('organization_invitations'))
    r.set('organization',org);r.set('email',email);r.set('role',role);r.set('token_hash',$security.sha256(secret));r.set('expires_at',new Date(Date.now()+7*86400000).toISOString());app.save(r)
  })
  e.response.header().set('Cache-Control','no-store');return e.json(201,{token:secret})
},$apis.requireAuth('users'))
routerAdd('DELETE','/api/i7y/organizations/{org}/invitations/{id}',e=>{
  const org=e.request.pathValue('org');require(__hooks+'/lib/organizations.js').requireRole(e,org,true,true)
  const r=e.app.findRecordById('organization_invitations',e.request.pathValue('id'))
  if(r.getString('organization')!==org)throw new NotFoundError('Invitation not found')
  r.set('revoked_at',new Date().toISOString());e.app.save(r);return e.noContent(204)
},$apis.requireAuth('users'))
routerAdd('POST','/api/i7y/invitations/inspect',e=>{
  const r=require(__hooks+'/lib/organizations.js').invite(e.app,String(e.requestInfo().body.token||''))
  e.response.header().set('Cache-Control','no-store')
  return e.json(200,{organization:e.app.findRecordById('organizations',r.getString('organization')).getString('name'),email:r.getString('email'),role:r.getString('role'),expires_at:r.getString('expires_at')})
},$apis.bodyLimit(4096))
routerAdd('POST','/api/i7y/invitations/accept',e=>{
  const b=e.requestInfo().body,lib=require(__hooks+'/lib/organizations.js')
  e.app.runInTransaction(app=>{
    const r=lib.invite(app,String(b.token||'')),email=r.getString('email')
    let user=e.auth
    if(user && (user.collection().name!=='users' || user.email().toLowerCase()!==email))throw new ForbiddenError('Sign in with the invited email')
    if(!user){
      let exists=false
      try{app.findAuthRecordByEmail('users',email);exists=true}catch(_){}
      if(exists)throw new BadRequestError('Sign in to your existing account')
      user=new Record(app.findCollectionByNameOrId('users'));user.set('email',email);user.set('name',String(b.name||'').trim());user.set('password',b.password);user.set('passwordConfirm',b.passwordConfirm);app.save(user)
    }
    const members=app.findRecordsByFilter('organization_memberships','organization={:org} && user={:user}','',1,0,{org:r.getString('organization'),user:user.id})
    if(members.length)throw new BadRequestError('Person is already a member')
    const m=new Record(app.findCollectionByNameOrId('organization_memberships'));m.set('organization',r.getString('organization'));m.set('user',user.id);m.set('role',r.getString('role'));app.save(m)
    r.set('used_at',new Date().toISOString());app.save(r)
  })
  return e.noContent(204)
},$apis.bodyLimit(8192))
routerAdd('POST','/api/i7y/workspaces/{id}/transfer',e=>{
  if(!e.auth.getBool('global_admin'))throw new ForbiddenError('Global administrator required')
  e.app.runInTransaction(app=>{
    const r=app.findRecordById('workspaces',e.request.pathValue('id')),org=String(e.requestInfo().body.organization||'')
    app.findRecordById('organizations',org)
    if(org===r.getString('organization'))return
    require(__hooks+'/lib/alerts.js').removeTarget(app,'workspace',r.id,'resource_transferred',e.auth.id)
    for(const agent of app.findRecordsByFilter('server_agents','server.workspace={:workspace}','',0,0,{workspace:r.id}))app.delete(agent)
    r.set('organization',org);app.save(r)
  });return e.noContent(204)
},$apis.requireAuth('users'))
