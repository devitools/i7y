function fail(status,message){throw new ApiError(status,message)}
function user(e,app=e.app){
  if(!e.auth || e.auth.collection().name!=='users' || e.get('i7yApiToken'))fail(401,'A user session is required')
  try{return app.findRecordById('users',e.auth.id)}catch(_){fail(401,'Sign in required')}
}
function organizations(app,current,selected=''){
  const lib=require(__hooks+'/lib/organizations.js')
  const accessible=current.getBool('global_admin')?app.findRecordsByFilter('organizations','','name,id',0,0):app.findRecordsByFilter('organization_memberships','user={:user}','',0,0,{user:current.id}).map(member=>{
    try{return app.findRecordById('organizations',member.getString('organization'))}catch(_){return null}
  }).filter(Boolean)
  if(selected && !accessible.some(record=>record.id===selected))fail(403,'Organization access denied')
  return accessible.filter(record=>!selected || record.id===selected).map(record=>({id:record.id,name:record.getString('name'),role:lib.role(app,current,record.id)}))
}
function response(e,app,operation){
  const http=require(__hooks+'/lib/alerts-http.js'),query=e.request.url.query()
  const selected=query.get('organization')||''
  if(selected && !/^[a-z0-9]{15}$/.test(selected))fail(400,'Invalid organization')
  const allowed=organizations(app,user(e,app),selected),byId={}
  for(const org of allowed)byId[org.id]=org
  const decorate=(item,organization)=>({...item,organization:organization||item.organization,organization_name:byId[organization||item.organization].name,organization_role:byId[organization||item.organization].role})
  if(operation==='incidents'){
    const result=http.listing(e,app,'incidents',allowed.map(org=>org.id))
    return {...result,items:result.items.map(item=>decorate(item))}
  }
  const cursor=query.get('cursor')||'0'
  if(!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))fail(400,'Invalid notification cursor')
  const limit=http.positiveInteger(query.get('limit'),100,100),engine=require(__hooks+'/lib/alerts.js')
  let openCount=0,next=Number(cursor),items=[]
  for(const org of allowed){
    const result=engine.validNotifications(app,org.id,cursor,limit)
    openCount+=result.open_count
    next=Math.max(next,Number(result.cursor))
    items.push(...result.items.map(item=>decorate(item,org.id)))
  }
  items.sort((a,b)=>Number(a.sequence)-Number(b.sequence))
  if(items.length>=limit){items=items.slice(0,limit);next=Number(items[items.length-1].sequence)}
  return {items,cursor:String(next),open_count:openCount}
}
function handle(e,operation){
  e.response.header().set('Cache-Control','no-store')
  let result
  e.app.runInTransaction(app=>{result=response(e,app,operation)})
  return e.json(200,result)
}
module.exports={handle,user,organizations}
