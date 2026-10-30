routerAdd('POST','/api/i7y/desktop/authorize',e=>{
  const body=e.requestInfo().body
  if(!/^[a-f0-9]{64}$/.test(String(body.request)) || !/^[a-f0-9]{64}$/.test(String(body.challenge)))throw new BadRequestError('Invalid desktop request')
  const record=new Record(e.app.findCollectionByNameOrId('desktop_authorizations'))
  record.set('request_hash',$security.sha256(body.request))
  record.set('challenge',body.challenge)
  record.set('user',e.auth.id)
  record.set('expires_at',new Date(Date.now()+120000).toISOString())
  e.app.save(record)
  e.response.header().set('Cache-Control','no-store')
  return e.noContent(204)
},$apis.requireAuth('users'),$apis.bodyLimit(2048))

routerAdd('POST','/api/i7y/desktop/exchange',e=>{
  e.response.header().set('Cache-Control','no-store')
  const body=e.requestInfo().body
  if(!/^[a-f0-9]{64}$/.test(String(body.request)) || !/^[a-f0-9]{64}$/.test(String(body.verifier)))throw new BadRequestError('Invalid desktop request')
  let user=null
  e.app.runInTransaction(app=>{
    let record
    try {record=app.findFirstRecordByFilter('desktop_authorizations','request_hash={:hash}',{hash:$security.sha256(body.request)})}
    catch (_) {return}
    if(record.getBool('consumed') || Date.parse(record.getString('expires_at').replace(' ','T'))<=Date.now())throw new BadRequestError('Desktop authorization expired')
    if(record.getString('challenge')!==$security.sha256(body.verifier))throw new BadRequestError('Invalid desktop proof')
    user=app.findRecordById('users',record.getString('user'))
    record.set('consumed',true)
    app.save(record)
  })
  if(!user)return e.json(202,{pending:true})
  return $apis.recordAuthResponse(e,user,'desktop')
},$apis.bodyLimit(2048))

cronAdd('desktop_authorization_cleanup','*/15 * * * *',()=>{
  for(const record of $app.findRecordsByFilter('desktop_authorizations','expires_at < {:cutoff}','',500,0,{cutoff:new Date(Date.now()-86400000).toISOString()}))$app.delete(record)
})

routerAdd('GET','/api/i7y/desktop',e=>{
  e.response.header().set('Cache-Control','no-store')
  return e.json(200,{browser_login:true})
})
