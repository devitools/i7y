import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, ContextChangedError, I7yClient, UnsupportedServerError, incidentPhase, incidentTimestamp, normalizeServerUrl, validateInfo } from '../apps/mobile/src/core/client.ts'

const server='https://inventory.example.com'
const info={instance_id:'installation_1234567890',protocol_version:1,capabilities:['browser_login','incidents']}
const session={token:'session-secret',record:{id:'user12345678901',email:'reader@example.com'},connectionId:'connection-123',serverUrl:server,instanceId:info.instance_id}
function deferred() {
  let resolve,reject
  const promise=new Promise((accept,decline)=>{resolve=accept;reject=decline})
  return {promise,resolve,reject}
}
function fixture(fetcher) {
  let state={serverUrl:server,session,organizationId:'organization123'}
  const calls=[]
  const api=new I7yClient(()=>state,async(url,options)=>{
    calls.push({url,options})
    return fetcher?fetcher(url,options):{status:200,ok:true,json:async()=>({ok:true})}
  })
  return {api,calls,setState:value=>{state=value}}
}

test('server URLs require production HTTPS and normalize only complete origins',()=>{
  assert.equal(normalizeServerUrl('  HTTPS://Inventory.Example.com:443///  '),server)
  assert.equal(normalizeServerUrl('https://inventory.example.com:8443/'),server+':8443')
  for(const value of ['http://inventory.example.com','http://127.0.0.1:8090','ftp://inventory.example.com','inventory.example.com','https://user:password@inventory.example.com','https://user@inventory.example.com','https://inventory.example.com/api','https://inventory.example.com/?token=secret','https://inventory.example.com/#fragment'])assert.throws(()=>normalizeServerUrl(value),undefined,value)
})

test('development HTTP is restricted to local and private network origins',()=>{
  for(const value of ['http://localhost:8090','http://127.0.0.1:8090','http://[::1]:8090','http://10.2.3.4:8090','http://192.168.1.2:8090','http://172.16.2.3:8090','http://172.31.2.3:8090'])assert.equal(normalizeServerUrl(value,true),new URL(value).origin)
  for(const value of ['http://inventory.example.com','http://172.32.2.3:8090','http://192.169.1.2:8090','http://127.0.0.1:8090/private'])assert.throws(()=>normalizeServerUrl(value,true),undefined,value)
})

test('protocol discovery requires the supported version and baseline capabilities',()=>{
  assert.equal(validateInfo(info),info)
  assert.equal(validateInfo({...info,capabilities:[...info.capabilities,'push'],push_gateway_url:'https://push.example.com'}).capabilities.includes('push'),true)
  for(const value of [null,{}, {...info,protocol_version:2},{...info,instance_id:'short'},{...info,instance_id:'bad/installation/identity'},{...info,capabilities:'incidents'},{...info,capabilities:['incidents']},{...info,capabilities:['browser_login']}])assert.throws(()=>validateInfo(value))
})

test('public discovery of another server carries no session or organization headers',async()=>{
  const {api,calls}=fixture(async()=>({status:200,ok:true,json:async()=>info}))
  assert.deepEqual(await api.info('https://other.example.com'),info)
  const {url,options}=calls[0]
  assert.equal(url,'https://other.example.com/api/i7y/mobile/v1/info')
  assert.equal(new Headers(options.headers).has('Authorization'),false)
  assert.equal(new Headers(options.headers).has('X-I7y-Organization'),false)
  assert.equal(options.redirect,'error')
  assert.equal(options.credentials,'omit')
})

test('discovery identifies an old server returning the web app or a missing route',async()=>{
  for(const response of [new Response('<!doctype html><html></html>',{status:200}),new Response('<html>Not found</html>',{status:404}),Response.json({message:'Not found'},{status:404}),Response.json({protocol_version:2})]) {
    const {api}=fixture(async()=>response)
    await assert.rejects(api.info(),UnsupportedServerError)
  }
})

test('discovery preserves transient failures instead of reporting protocol incompatibility',async()=>{
  const offline=new TypeError('Network request failed')
  const {api}=fixture(async()=>{throw offline})
  await assert.rejects(api.info(),error=>error===offline)
  const {api:unavailable}=fixture(async()=>new Response('<html>Service unavailable</html>',{status:503}))
  await assert.rejects(unavailable.info(),error=>!(error instanceof UnsupportedServerError))
})

test('authenticated requests capture their user and selected organization context',async()=>{
  const {api,calls,setState}=fixture()
  await api.incidents({severity:'critical',page:2,search:'service & database',empty:'',missing:null})
  const first=calls[0]
  const url=new URL(first.url)
  assert.equal(url.origin,server)
  assert.equal(url.searchParams.get('severity'),'critical')
  assert.equal(url.searchParams.get('page'),'2')
  assert.equal(url.searchParams.get('search'),'service & database')
  assert.equal(url.searchParams.has('empty'),false)
  assert.equal(url.searchParams.has('missing'),false)
  assert.equal(first.options.headers.Authorization,'Bearer session-secret')
  assert.equal(first.options.headers['X-I7y-Organization'],'organization123')
  assert.equal(first.options.redirect,'error')
  assert.equal(first.options.credentials,'omit')
  setState({serverUrl:server,session:{...session,token:'second-session',record:{id:'another-user',email:'admin@example.com',global_admin:true}},organizationId:'other-organization'})
  await api.organizations()
  assert.equal(calls[1].options.headers.Authorization,'Bearer second-session')
  assert.equal(calls[1].options.headers['X-I7y-Organization'],'other-organization')
  assert.equal(first.options.headers.Authorization,'Bearer session-secret')
})

test('private requests require a session and reject non-API paths before fetching',async()=>{
  const {api,calls,setState}=fixture()
  for(const path of ['/private','//other.example.com/api/x','https://other.example.com/api/x','api/x'])await assert.rejects(api.request(path),/Invalid API request/)
  setState({serverUrl:server,session:null,organizationId:null})
  await assert.rejects(api.incidents(),error=>error instanceof ApiError && error.status===401)
  assert.equal(calls.length,0)
})

test('private requests cannot override or inherit an origin belonging to another session',async()=>{
  const {api,calls,setState}=fixture()
  await assert.rejects(api.request('/api/i7y/organizations',{serverUrl:'https://other.example.com'}))
  setState({serverUrl:'https://other.example.com',session,organizationId:'organization123'})
  await assert.rejects(api.organizations())
  assert.equal(calls.length,0)
})

test('context invalidation rejects a response before consuming its JSON',async()=>{
  const response=deferred()
  let parsed=false
  const {api,calls}=fixture(()=>response.promise)
  const request=api.incidents()
  api.invalidate()
  assert.equal(calls[0].options.signal.aborted,true)
  response.resolve({status:200,ok:true,json:async()=>{parsed=true;return {items:[{id:'private-incident'}]}}})
  await assert.rejects(request,ContextChangedError)
  assert.equal(parsed,false)
})

test('context invalidation also rejects a response whose JSON was still parsing',async()=>{
  const parsing=deferred(),entered=deferred()
  const {api}=fixture(async()=>({status:200,ok:true,json:()=>{entered.resolve();return parsing.promise}}))
  const request=api.incidents()
  await entered.promise
  api.invalidate()
  parsing.resolve({items:[{id:'private-incident'}]})
  await assert.rejects(request,ContextChangedError)
})

test('caller cancellation reaches fetch and cleans up the signal subscription',async()=>{
  const controller=new AbortController()
  let subscriptions=0
  const signal={get aborted(){return controller.signal.aborted},addEventListener(type,listener,options){subscriptions++;controller.signal.addEventListener(type,listener,options)},removeEventListener(type,listener){subscriptions--;controller.signal.removeEventListener(type,listener)}}
  const {api,calls}=fixture(async(_url,options)=>new Promise((_resolve,reject)=>{
    const abort=()=>reject(new DOMException('Aborted','AbortError'))
    if(options.signal.aborted)abort()
    else options.signal.addEventListener('abort',abort,{once:true})
  }))
  const request=api.request('/api/i7y/organizations',{signal})
  controller.abort()
  await assert.rejects(request,error=>error.name==='AbortError')
  assert.equal(calls[0].options.signal.aborted,true)
  assert.equal(subscriptions,0)
})

test('an already cancelled caller signal cannot start an active network operation',async()=>{
  const controller=new AbortController()
  controller.abort()
  const {api,calls}=fixture(async(_url,options)=>{
    assert.equal(options.signal.aborted,true)
    throw new DOMException('Aborted','AbortError')
  })
  await assert.rejects(api.request('/api/i7y/organizations',{signal:controller.signal}),error=>error.name==='AbortError')
  assert.equal(calls.length,1)
})

test('versioned incident actions preserve their expected version and encode identifiers',async()=>{
  const {api,calls}=fixture()
  const deadline='2026-10-29T14:30:00.000Z'
  await api.claim('incident/with space',deadline,7)
  await api.resolve('incident/with space',8)
  assert.equal(new URL(calls[0].url).pathname,'/api/i7y/alerts/v1/incidents/incident%2Fwith%20space/claim')
  assert.equal(calls[0].options.method,'POST')
  assert.deepEqual(JSON.parse(calls[0].options.body),{claim_until:deadline,version:7})
  assert.deepEqual(JSON.parse(calls[1].options.body),{version:8})
  assert.equal(calls[0].options.headers['Content-Type'],'application/json')
})

test('notification polling preserves the backend cursor contract',async()=>{
  const page={items:[{incident_id:'incident1234567'}],cursor:'42',open_count:3}
  const {api,calls}=fixture(async()=>({status:200,ok:true,json:async()=>page}))
  assert.equal((await api.notifications('41')).cursor,'42')
  assert.equal(new URL(calls[0].url).searchParams.get('cursor'),'41')
  assert.equal(new URL(calls[0].url).searchParams.get('limit'),'100')
})

test('PocketBase timestamps without an explicit zone are interpreted as UTC',()=>{
  const expected=Date.parse('2026-10-29T12:30:00.000Z')
  assert.equal(incidentTimestamp('2026-10-29 12:30:00.000Z'),expected)
  assert.equal(incidentTimestamp('2026-10-29 12:30:00.000'),expected)
  assert.equal(incidentTimestamp('2026-10-29T09:30:00-03:00'),expected)
  assert.equal(Number.isNaN(incidentTimestamp('')),true)
  const incident={status:'open',assignee:'user123',claim_until:'2026-10-29 12:30:00.000'}
  assert.equal(incidentPhase(incident,expected-1),'inProgress')
  assert.equal(incidentPhase(incident,expected),'overdue')
  assert.equal(incidentPhase({...incident,assignee:''},expected),'open')
  assert.equal(incidentPhase({...incident,status:'resolved'},expected),'resolved')
})

test('API errors retain their status and no-content responses skip JSON parsing',async()=>{
  const conflict=fixture(async()=>({status:409,ok:false,json:async()=>({message:'Incident changed'})}))
  await assert.rejects(conflict.api.resolve('incident1234567',1),error=>error instanceof ApiError && error.status===409 && error.message==='Incident changed')
  const empty=fixture(async()=>({status:204,ok:true,json:async()=>{throw new Error('Unexpected JSON parse')}}))
  assert.equal(await empty.api.request('/api/i7y/mobile/v1/devices/device123',{method:'DELETE'}),null)
})
