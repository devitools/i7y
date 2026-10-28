routerUse(new Middleware((e) => {
  const token = e.request.header.get('Authorization').replace(/^Bearer\s+/i, '').trim()
  if (!token.startsWith('i7y_')) return e.next()
  if (!/^i7y_[A-Za-z0-9]{64}$/.test(token)) throw new UnauthorizedError('Invalid API token')
  let record
  try { record = e.app.findFirstRecordByFilter('api_tokens','token_hash = {:hash}',{hash:$security.sha256(token)}) }
  catch (_) { throw new UnauthorizedError('Invalid API token') }
  if (Date.parse(record.getString('expires_at').replace(' ','T')) <= Date.now()) throw new UnauthorizedError('Expired API token')
  const path = e.request.url.path
  if (path !== '/api/i7y/token' && !/^\/api\/collections\/(workspaces|servers|projects|containers)\/records(?:\/[a-z0-9]{15})?$/.test(path)) throw new ForbiddenError('API tokens only access inventory records')
  const method = e.request.method
  if (path === '/api/i7y/token' && method !== 'GET') throw new ForbiddenError('Only token inspection is allowed')
  if (!['GET','POST','PATCH','DELETE'].includes(method) || (method !== 'GET' && record.getString('scope') !== 'write')) throw new ForbiddenError('This token only allows reading inventory')
  try { e.auth = e.app.findRecordById('users',record.getString('user')) }
  catch (_) { throw new UnauthorizedError('Invalid API token') }
  const org=record.getString('organization')
  const selected=e.request.header.get('X-I7y-Organization')
  if(selected && selected!==org)throw new ForbiddenError('Token organization mismatch')
  e.request.header.set('X-I7y-Organization',org)
  e.requestInfo().headers['x_i7y_organization']=org
  require(__hooks+'/lib/organizations.js').requireRole(e,org,method!=='GET')
  e.set('i7yApiToken',record)
  return e.next()
}, -1001))

routerAdd('GET','/api/i7y/tokens',(e) => {
  e.response.header().set('Cache-Control','no-store')
  const records = e.app.findRecordsByFilter('api_tokens','user = {:user} && organization = {:org}','-created',100,0,{user:e.auth.id,org:e.request.header.get('X-I7y-Organization')})
  const metadata = require(__hooks + '/lib/tokens.js').metadata
  return e.json(200,{items:records.map(metadata)})
}, $apis.requireAuth('users'))

routerAdd('POST','/api/i7y/tokens',(e) => {
  const body = e.requestInfo().body
  const organization=String(body.organization || e.request.header.get('X-I7y-Organization') || '')
  require(__hooks+'/lib/organizations.js').requireRole(e,organization,body.scope==='write')
  const label = String(body.label || '').trim()
  const days = Number(body.days)
  const scope = body.scope
  if (!label || label.length > 80 || !Number.isInteger(days) || days < 1 || days > 365 || !['read','write'].includes(scope)) throw new BadRequestError('Provide a label, read/write scope and a duration from 1 to 365 days')
  const existing = e.app.findRecordsByFilter('api_tokens','user = {:user}','',100,0,{user:e.auth.id})
  if (existing.length >= 100) throw new BadRequestError('Revoke an existing token before creating another')
  const token = 'i7y_' + $security.randomString(64)
  const record = new Record(e.app.findCollectionByNameOrId('api_tokens'))
  record.set('user',e.auth.id)
  record.set('organization',organization)
  record.set('label',label)
  record.set('token_hash',$security.sha256(token))
  record.set('prefix',token.slice(0,12))
  record.set('scope',scope)
  record.set('expires_at',new Date(Date.now() + days * 86400000).toISOString())
  e.app.save(record)
  e.response.header().set('Cache-Control','no-store')
  return e.json(201,{...require(__hooks + '/lib/tokens.js').metadata(record),token})
}, $apis.requireAuth('users'))

routerAdd('DELETE','/api/i7y/tokens/{id}',(e) => {
  const record = e.app.findRecordById('api_tokens',e.request.pathValue('id'))
  if (record.getString('user') !== e.auth.id) throw new NotFoundError('Token not found')
  e.app.delete(record)
  return e.noContent(204)
}, $apis.requireAuth('users'))

routerAdd('GET','/api/i7y/token',(e) => {
  const record = e.get('i7yApiToken')
  if (!record) throw new BadRequestError('Provide an agent API token')
  e.response.header().set('Cache-Control','no-store')
  return e.json(200,require(__hooks + '/lib/tokens.js').metadata(record))
}, $apis.requireAuth('users'))
