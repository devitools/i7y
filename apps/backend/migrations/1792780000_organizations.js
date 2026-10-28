migrate(app => {
  const relation=(name,target,required=true,cascadeDelete=false)=>({type:'relation',name,collectionId:app.findCollectionByNameOrId(target).id,maxSelect:1,required,cascadeDelete})
  const date=name=>({type:'date',name})
  app.save(new Collection({name:'organizations',type:'base',fields:[{type:'text',name:'name',required:true,max:120},{type:'bool',name:'initial'}]}))
  app.save(new Collection({name:'organization_memberships',type:'base',fields:[relation('organization','organizations',true,true),relation('user','users',true,true),{type:'select',name:'role',required:true,maxSelect:1,values:['admin','editor','reader']}],indexes:['CREATE UNIQUE INDEX idx_membership_identity ON organization_memberships (organization,user)','CREATE INDEX idx_membership_user ON organization_memberships (user)']}))
  app.save(new Collection({name:'organization_invitations',type:'base',fields:[relation('organization','organizations',true,true),{type:'email',name:'email',required:true},{type:'select',name:'role',required:true,maxSelect:1,values:['admin','editor','reader']},{type:'text',name:'token_hash',required:true,hidden:true},date('expires_at'),date('used_at'),date('revoked_at')],indexes:['CREATE UNIQUE INDEX idx_invitation_hash ON organization_invitations (token_hash)','CREATE INDEX idx_invitation_org ON organization_invitations (organization)']}))
  const users=app.findCollectionByNameOrId('users')
  users.fields.add(new BoolField({name:'global_admin'}))
  users.updateRule='id = @request.auth.id && @request.body.global_admin:changed = false'
  app.save(users)
  const initial=new Record(app.findCollectionByNameOrId('organizations'))
  initial.set('name','Initial organization');initial.set('initial',true);app.save(initial)
  for(const user of app.findAllRecords('users')) {
    const m=new Record(app.findCollectionByNameOrId('organization_memberships'))
    m.set('organization',initial.id);m.set('user',user.id);m.set('role','admin');app.save(m)
  }
  for(const name of ['workspaces','api_tokens']) {
    const c=app.findCollectionByNameOrId(name)
    c.fields.add(new RelationField(relation('organization','organizations',false,name==='api_tokens')))
    app.save(c)
    for(const r of app.findAllRecords(name)){r.set('organization',initial.id);app.save(r)}
    c.fields.getByName('organization').required=true
    c.indexes=[...c.indexes,'CREATE INDEX idx_'+name+'_organization ON '+name+' (organization)']
    app.save(c)
  }
  const paths={workspaces:'organization',servers:'workspace.organization',projects:'server.workspace.organization',containers:'project.server.workspace.organization',telemetry_samples:'server.workspace.organization',server_agents:'server.workspace.organization'}
  const rule=(path,write=false)=>'@request.auth.collectionName = "users" && (@request.headers.x_i7y_organization = "" || '+path+' = @request.headers.x_i7y_organization) && (@request.auth.global_admin = true || (@collection.organization_memberships:access.organization ?= '+path+' && @collection.organization_memberships:access.user ?= @request.auth.id'+(write?' && (@collection.organization_memberships:access.role = "admin" || @collection.organization_memberships:access.role = "editor")':'')+'))'
  for(const name in paths) {
    const c=app.findCollectionByNameOrId(name)
    c.listRule=rule(paths[name]);c.viewRule=c.listRule
    if(!['telemetry_samples','server_agents'].includes(name)){c.createRule='@request.auth.collectionName = "users"';c.updateRule=c.listRule;c.deleteRule=c.listRule}
    app.save(c)
  }
  for(const name of ['workspaces','servers','projects','containers']) {
    const c=app.findCollectionByNameOrId('i7y_'+name)
    c.viewQuery=c.viewQuery.replace('SELECT ', 'SELECT w.organization AS organization,')
    c.listRule=rule('organization');c.viewRule=c.listRule;app.save(c)
  }
  const images=app.findCollectionByNameOrId('i7y_images')
  images.viewQuery="WITH image_groups AS (SELECT min(c.id)||'_'||w.organization AS id,w.organization,'' AS workspace_login,c.image AS name,count(*) AS count,c.image AS search_text,json_object('key',c.image,'name',c.image,'count',count(*)) AS payload FROM containers c JOIN projects p ON p.id=c.project JOIN servers s ON s.id=p.server JOIN workspaces w ON w.id=s.workspace GROUP BY w.organization,c.image UNION ALL SELECT min(c.id)||'_'||w.id AS id,w.organization,w.login AS workspace_login,c.image AS name,count(*) AS count,c.image AS search_text,json_object('key',c.image,'name',c.image,'count',count(*)) AS payload FROM containers c JOIN projects p ON p.id=c.project JOIN servers s ON s.id=p.server JOIN workspaces w ON w.id=s.workspace GROUP BY w.id,c.image) SELECT id,organization,workspace_login,name,count,search_text,payload FROM image_groups"
  images.viewQuery=images.viewQuery.split(' GROUP BY ').join(" WHERE (CASE WHEN json_valid(c.telemetry) THEN coalesce(json_extract(c.telemetry,'$.state'),'unknown') ELSE 'unknown' END) NOT IN ('missing','removed') GROUP BY ")
  images.listRule=rule('organization');images.viewRule=images.listRule;app.save(images)
},app=>{throw new Error('Restore the pre-migration backup with the previous image; organization migration has no destructive down migration')})
