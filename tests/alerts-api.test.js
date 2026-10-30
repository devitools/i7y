import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import crypto from 'node:crypto'

const source=fs.readFileSync(new URL('../apps/backend/hooks/lib/alerts-http.js',import.meta.url),'utf8')
const sha256=value=>crypto.createHash('sha256').update(value).digest('hex')
class ApiError extends Error {constructor(status,message){super(message);this.status=status}}
class Row {
  constructor(collection,values={}){this.values={...values};this.id=values.id||'record000000001';this.table=collection}
  getString(key){const value=this.values[key];return value && typeof value==='object'?JSON.stringify(value):String(value??'')}
  getInt(key){return Number(this.values[key])||0}
  getFloat(key){return Number(this.values[key])||0}
  getBool(key){return !!this.values[key]}
  set(key,value){this.values[key]=value}
  collection(){return {name:this.table}}
}
function load(overrides={}){
  const context={module:{exports:{}},ApiError,Record:Row,__hooks:'/hooks',$security:{sha256},require:path=>{
    if(path.endsWith('organizations.js'))return {role:(app)=>app.currentRole}
    if(path.endsWith('alert-capabilities.js'))return {capabilities:record=>JSON.parse(record.getString('capabilities')||'[]')}
    throw new Error('Unexpected module '+path)
  },...overrides}
  vm.runInNewContext(source,context)
  return context.module.exports
}
function plain(value){return JSON.parse(JSON.stringify(value))}
function rejects(status,run){assert.throws(run,error=>error.status===status)}

test('Cloud Monitoring accepts optional omissions and rejects incompatible state/schema/identity',()=>{
  const http=load()
  const event=plain(http.normalizeGcp({version:'1.2',incident:{incident_id:'gcp-1',state:'open'}}))
  assert.equal(event.external_id,'gcp-1')
  assert.equal(event.state,'open')
  assert.equal(event.severity,'warning')
  for(const body of [
    {version:'1.0',incident:{incident_id:'gcp-1',state:'open'}},
    {version:'1.2',incident:{incident_id:'gcp-1',state:'acknowledged'}},
    {version:'1.2',incident:{incident_id:'',state:'closed'}},
    {version:'1.2',incident:{incident_id:12,state:'open'}},
  ])rejects(400,()=>http.normalizeGcp(body))
  const hostile=plain(http.normalizeGcp({version:'1.2',incident:{incident_id:'gcp-1',state:'closed',summary:'<img src=x onerror=alert(1)>',url:'javascript:alert(1)',documentation:{content:'<script>untrusted</script>'}}}))
  assert.equal(hostile.state,'closed')
  assert.equal(hostile.title,'<img src=x onerror=alert(1)>')
  assert.equal(hostile.evidence.url,undefined)
  assert.equal(hostile.evidence.documentation.content,'<script>untrusted</script>')
})

test('source normalization bounds identity and evidence without guessing state from prose',()=>{
  const http=load()
  assert.equal(http.normalizeEvent({external_id:'same',state:'open',title:'Incident is CLOSED'}).state,'open')
  rejects(400,()=>http.normalizeEvent({external_id:'x'.repeat(241),state:'open'}))
  rejects(400,()=>http.normalizeEvent({external_id:'x',state:'open',evidence:{content:'x'.repeat(131073)}}))
  rejects(400,()=>http.normalizeEvent({external_id:'x',state:'open',severity:'admin'}))
})

test('claim deadlines require explicit UTC rather than locale-dependent or numeric dates',()=>{
  const http=load()
  assert.equal(http.claimDeadline('2026-10-29T02:00:00.000Z'),'2026-10-29T02:00:00.000Z')
  assert.equal(http.claimDeadline('2026-10-29T02:00:00+00:00'),'2026-10-29T02:00:00+00:00')
  assert.equal(http.claimDeadline('2026-10-29T02:00:00.123456+00:00'),'2026-10-29T02:00:00.123456+00:00')
  assert.equal(http.claimDeadline('2026-10-29T02:00:00.123456789Z'),'2026-10-29T02:00:00.123456789Z')
  for(const value of [1793239200000,'2026-10-29T02:00:00','2026-10-29T02:00:00-03:00','tomorrow'])rejects(400,()=>http.claimDeadline(value))
})

test('idempotency namespaces producers and operations, preserves replays, and rejects changed payloads',()=>{
  const rows=[],http=load()
  const app={findCollectionByNameOrId:name=>name,save:record=>rows.push(record),findRecordsByFilter:(_name,_filter,_sort,_limit,_offset,params)=>rows.filter(row=>['organization','producer','operation','key'].every(key=>row.getString(key)===params[key==='organization'?'org':key]))}
  let calls=0
  const act=()=>({id:'incident-'+(++calls)})
  const submit=(org,producer,operation,body)=>http.receipt(app,org,producer,operation,'shared',body,act,true)
  assert.equal(submit('a','integration:1','source-event',{state:'open',external_id:'id'}).id,'incident-1')
  assert.equal(submit('a','integration:1','source-event',{external_id:'id',state:'open'}).id,'incident-1')
  assert.equal(calls,1)
  assert.equal(submit('a','integration:2','source-event',{external_id:'id',state:'open'}).id,'incident-2')
  assert.equal(submit('b','integration:1','source-event',{external_id:'id',state:'open'}).id,'incident-3')
  assert.equal(submit('a','integration:1','another-operation',{external_id:'id',state:'open'}).id,'incident-4')
  rejects(409,()=>submit('a','integration:1','source-event',{external_id:'id',state:'closed'}))
  rejects(400,()=>http.receipt(app,'a','token:1','incident-create','',{},act,true))
  assert.equal(calls,4)
})

test('mutation permission rechecks token revocation, capabilities and current membership',()=>{
  const token='i7y_'+'A'.repeat(64),user=new Row('users',{id:'user00000000001'})
  const issued=new Row('api_tokens',{id:'token0000000001',user:user.id,organization:'org000000000001',token_hash:sha256(token),expires_at:'2099-01-01T00:00:00Z',capabilities:['incidents:create']})
  const app={currentRole:'editor',findRecordById:(table,id)=>{if(table==='users')return user;if(table==='api_tokens' && !app.revoked)return issued;if(table==='organizations')return {id};throw new Error('missing')}}
  const headers={'X-I7y-Organization':'org000000000001',Authorization:'Bearer '+token}
  const e={auth:user,get:()=>issued,request:{header:{get:key=>headers[key]||''}}}
  const http=load()
  assert.equal(http.permission(e,app,'incidents:create',true).producer,'token:'+issued.id)
  rejects(403,()=>http.permission(e,app,'incidents:resolve',true))
  rejects(403,()=>http.permission(e,app,'incidents:create',true,true))
  app.currentRole='reader'
  rejects(403,()=>http.permission(e,app,'incidents:create',true))
  app.currentRole=''
  rejects(403,()=>http.permission(e,app,'incidents:create'))
  app.currentRole='editor';issued.set('capabilities',[])
  rejects(403,()=>http.permission(e,app,'incidents:create',true))
  issued.set('capabilities',['incidents:create']);headers['X-I7y-Organization']='org000000000002'
  rejects(401,()=>http.permission(e,app,'incidents:create',true))
  headers['X-I7y-Organization']='org000000000001';app.revoked=true
  rejects(401,()=>http.permission(e,app,'incidents:create',true))
})

test('integration credential authentication never falls back to a signed-in user',()=>{
  const token='i7yh_'+'A'.repeat(64),record=new Row('alert_integrations',{id:'integration0001',organization:'org000000000001',kind:'gcp',enabled:true,token_hash:sha256(token)})
  let tuple=['integration0001',token,true],authorization='Basic encoded'
  const app={findRecordById:(table)=>table==='alert_integrations'?record:{id:'org000000000001'}}
  const responseHeaders={}
  const e={auth:{id:'signed-in'},request:{pathValue:()=>record.id,basicAuth:()=>tuple,header:{get:key=>key==='Authorization'?authorization:''}},response:{header:()=>({set:(key,value)=>responseHeaders[key]=value})}}
  const http=load()
  assert.equal(http.credential(e,app,'gcp').id,record.id)
  tuple=['another-integration',token,true]
  rejects(401,()=>http.credential(e,app,'gcp'))
  assert.match(responseHeaders['WWW-Authenticate'],/^Basic /)
  tuple=['integration0001',token,true];record.set('enabled',false)
  rejects(401,()=>http.credential(e,app,'gcp'))
  record.set('enabled',true);record.set('token_hash',sha256('rotated'))
  rejects(401,()=>http.credential(e,app,'gcp'))
  authorization=''
  rejects(401,()=>http.credential(e,app,'gcp'))
})

test('safe DTOs never expose credential hashes or source namespace internals',()=>{
  const http=load(),record=new Row('alert_integrations',{id:'integration0001',organization:'org000000000001',name:'GCP',kind:'gcp',enabled:true,reminder_seconds:900,token_hash:'sensitive',prefix:'i7yh_abc',last_event:{external_id:'event',state:'open'}})
  const result=plain(http.dto(record))
  assert.equal(result.enabled,true)
  assert.equal(result.reminder_seconds,900)
  assert.equal(result.last_event.external_id,'event')
  assert.equal('token_hash' in result,false)
})
