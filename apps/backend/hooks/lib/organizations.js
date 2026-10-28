function role(app,user,organization) {
  if(!user || user.collection().name!=='users') return ''
  if(user.getBool('global_admin')) return 'admin'
  try{return app.findFirstRecordByFilter('organization_memberships','organization={:org} && user={:user}',{org:organization,user:user.id}).getString('role')}catch(_){return ''}
}
function requireRole(e,organization,write=false,admin=false) {
  const r=role(e.app,e.auth,organization)
  if(!r || (write && r==='reader') || (admin && r!=='admin')) throw new ForbiddenError('Organization access denied')
  const selected=e.requestInfo().headers['x_i7y_organization'] || ''
  if(selected && selected!==organization)throw new ForbiddenError('Organization context mismatch')
  return r
}
function organization(app,record) {
  const name=record.collection().name
  if(name==='workspaces')return record.getString('organization')
  const parent={servers:['workspaces','workspace'],projects:['servers','server'],containers:['projects','project'],server_agents:['servers','server'],telemetry_samples:['servers','server']}[name]
  if(!parent)throw new BadRequestError('Unsupported inventory record')
  return organization(app,app.findRecordById(parent[0],record.getString(parent[1])))
}
function invite(app,secret) {
  if(!/^i7yi_[A-Za-z0-9]{64}$/.test(secret))throw new NotFoundError('Invitation unavailable')
  let r
  try{r=app.findFirstRecordByFilter('organization_invitations','token_hash={:hash}',{hash:$security.sha256(secret)})}catch(_){throw new NotFoundError('Invitation unavailable')}
  if(r.getString('used_at') || r.getString('revoked_at') || Date.parse(r.getString('expires_at').replace(' ','T'))<=Date.now())throw new BadRequestError('Invitation expired, revoked or already used')
  return r
}
module.exports={role,requireRole,organization,invite}
