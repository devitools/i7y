import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const localized={module:{exports:{}}};vm.runInNewContext(fs.readFileSync(new URL('../apps/backend/hooks/lib/locales/mobile-push.js',import.meta.url),'utf8'),localized)
const context={__hooks:'/hooks',require:()=>localized.module.exports,module:{exports:{}},Date,Math,Object,String,Number,Boolean}
vm.runInNewContext(fs.readFileSync(new URL('../apps/backend/hooks/lib/mobile.js',import.meta.url),'utf8'),context)
const mobile=context.module.exports
const record=(id,values)=>({id,getString:key=>String(values[key] || ''),getInt:key=>Number(values[key] || 0),getBool:key=>Boolean(values[key])})
test('push configuration fails closed and permits HTTP only in explicit loopback tests',()=>{
  const config=values=>mobile.configuration(key=>values[key])
  assert.equal(config({I7Y_PUSH_GATEWAY_URL:'https://push.example.com'}).enabled,false)
  assert.equal(config({I7Y_MOBILE_ENCRYPTION_KEY:'k'.repeat(32),I7Y_PUSH_GATEWAY_URL:'https://push.example.com'}).enabled,true)
  for(const url of ['https://user:secret@push.example.com','https://push.example.com/path','http://push.example.com','http://127.0.0.1:9000','https://push.example.com?token=x','https://push.example.com:99999','https://a..b','https://127.0.0.1','https://localhost'])assert.equal(config({I7Y_MOBILE_ENCRYPTION_KEY:'k'.repeat(32),I7Y_PUSH_GATEWAY_URL:url}).enabled,false,url)
  assert.equal(config({I7Y_MOBILE_ENCRYPTION_KEY:'k'.repeat(32),I7Y_PUSH_GATEWAY_URL:'http://127.0.0.1:9000',I7Y_MOBILE_TEST_MODE:'1'}).enabled,true)
})
test('mobile proofs bind request audience and server identity',()=>{
  const body={request:'a'.repeat(64),challenge:'b'.repeat(64),instance_id:'installation'}
  assert.equal(mobile.proof(body,'installation',false),true)
  for(const change of [{instance_id:'other'},{audience:'desktop'},{request:'A'.repeat(64)},{challenge:'invalid'}])assert.equal(mobile.proof({...body,...change},'installation',false),false)
})
test('device binding rejects malformed UUIDs, capabilities and payload injection',()=>{
  const body={connection_id:'c00de123-1234-4123-8123-c00de1234567',binding_id:'b'.repeat(32),send_token:'s'.repeat(64)}
  assert.equal(mobile.deviceInput(body),true)
  for(const change of [{connection_id:'invalid'},{binding_id:'../../escape'},{send_token:'short'}])assert.equal(mobile.deviceInput({...body,...change}),false)
})
test('notice eligibility rejects replay, claims, resolution, revocation and stale generations',()=>{
  const values={sequence:20,valid:true,organization:'org',schedule_generation:3},incident={status:'open',organization:'org',schedule_generation:3},device={active:true,start_sequence:19}
  const eligible=(notice=values,problem=incident,binding=device)=>mobile.eligible(record('n',notice),record('i',problem),record('d',binding),Date.now())
  assert.equal(eligible(),true)
  assert.equal(eligible({...values,sequence:19}),false)
  assert.equal(eligible({...values,valid:false}),false)
  assert.equal(eligible(values,{...incident,claim_until:new Date(Date.now()+60000).toISOString()}),false)
  assert.equal(eligible(values,{...incident,status:'resolved'}),false)
  assert.equal(eligible(values,{...incident,schedule_generation:4}),false)
  assert.equal(eligible(values,incident,{...device,active:false}),false)
})
test('push projection shows incident summary without evidence or internal resource identifiers',()=>{
  const payload=mobile.projection(record('incident1234567',{organization:'org123456789012',origin:'rule',title:'Full disk',resource_id:'secret@email.test',resource_name:'coin.hospic.io',rule_revision:1,evidence:'Secret evidence',severity:'critical'}),'event-device')
  assert.equal(payload.title,'[i7y] Full disk 🚨')
  assert.equal(payload.resource,'coin.hospic.io: Full disk — Critical incident is open.')
  assert.equal(payload.ttl,60)
  assert.equal(JSON.stringify(payload).includes('Secret'),false)
  assert.equal(JSON.stringify(payload).includes('secret@'),false)
  const long=mobile.projection(record('incident1234567',{organization:'org123456789012',origin:'api',title:'😀'.repeat(200)+'\n',resource_name:'😀'.repeat(200),severity:'other'}),'event-device')
  assert.ok(Buffer.byteLength(long.title)<=120)
  assert.ok(Buffer.byteLength(long.resource)<=512)
  assert.equal(long.severity,'warning')
})
test('gateway outcomes distinguish invalid bindings, permanent errors and bounded retries',()=>{
  assert.equal(mobile.outcome(202,{}),'accepted')
  assert.equal(mobile.outcome(200,{status:'invalid'}),'invalid')
  for(const status of [401,403,404,410])assert.equal(mobile.outcome(status,{}),'invalid')
  for(const status of [0,408,429,500,503])assert.equal(mobile.outcome(status,{}),'retry')
  assert.equal(mobile.outcome(422,{status:'permanent_failure',code:'invalid_token'}),'invalid')
  assert.equal(mobile.outcome(422,{status:'permanent_failure',code:'provider_rejected'}),'permanent_failure')
  assert.equal(mobile.outcome(409,{code:'idempotency_conflict'}),'permanent_failure')
  assert.equal(mobile.outcome(400,{}),'permanent_failure')
  assert.equal(mobile.retryDelay(1),15000)
  assert.equal(mobile.retryDelay(99),3600000)
})

test('push templates follow each device language and keep authored alert names unchanged',()=>{
 const incident=record('incident1234567',{organization:'org123456789012',title:'Full disk',resource_name:'coin.hospic.io',severity:'critical'})
 for(const language of ['en','pt-BR','uk']){
  const payload=mobile.projection(incident,'event-device',language)
  assert.equal(payload.title,'[i7y] Full disk 🚨')
  assert.equal(payload.resource,'coin.hospic.io: Full disk — '+localized.module.exports[language].open.replace('{severity}',localized.module.exports[language].critical))
 }
 assert.equal(mobile.projection(incident,'event-device','unsupported').resource,mobile.projection(incident,'event-device','en').resource)
})

test('overdue pushes include the expired claim deadline and device display context',()=>{
 const now=Date.parse('2026-10-30T00:00:00Z')
 const values={organization:'org123456789012',title:'Full disk',resource_name:'coin.hospic.io',severity:'critical',status:'open',claim_until:'2026-10-29 22:09:32.000Z'}
 const payload=mobile.projection(record('incident1234567',values),'event-device','pt-BR','America/Fortaleza',now)
 assert.equal(payload.title,'[i7y] Full disk ⏰')
 assert.equal(payload.resource,'coin.hospic.io: Full disk — '+localized.module.exports['pt-BR'].overdue.replace('{severity}',localized.module.exports['pt-BR'].critical)+' '+localized.module.exports['pt-BR'].deadline)
 assert.equal(payload.deadline_at,'2026-10-29T22:09:32.000Z')
 assert.equal(payload.time_zone,'America/Fortaleza')
 for(const claim_until of ['', 'invalid', '2026-10-31T00:00:00Z']) {
  const open=mobile.projection(record('incident1234567',{...values,claim_until}),'event-device','en','UTC',now)
  assert.equal(open.deadline_at,undefined)
  assert.equal(open.resource,'coin.hospic.io: Full disk — Critical incident is open.')
 }
})

test('claim start notifications bypass reminder pauses only while the claim remains active',()=>{
 const now=Date.now(),incident={organization:'org',status:'open',schedule_generation:2,claim_until:new Date(now+60000).toISOString()},device=record('device',{active:true,start_sequence:0})
 const notice={organization:'org',valid:true,sequence:1,schedule_generation:2,kind:'claimed'}
 assert.equal(mobile.eligible(record('notice',notice),record('incident',incident),device,now),true)
 assert.equal(mobile.eligible(record('notice',{...notice,kind:'reminder'}),record('incident',incident),device,now),false)
 assert.equal(mobile.eligible(record('notice',notice),record('incident',{...incident,claim_until:new Date(now-1).toISOString()}),device,now),false)
 const payload=mobile.projection(record('incident',{...incident,title:'Full disk',resource_name:'coin.hospic.io',severity:'critical'}),'event','en','America/Fortaleza',now,'claimed','William')
 assert.equal(payload.title,'[i7y] Full disk 👤')
 assert.ok(payload.resource.includes('being handled by William'))
 assert.ok(payload.resource.includes('{deadline}'))
 assert.equal(payload.deadline_at,incident.claim_until)
})

test('resolution pushes use the resolver and resolution time instead of the former claim deadline',()=>{
 const values={organization:'org',title:'Full disk',resource_name:'coin.hospic.io',severity:'critical',status:'resolved',resolution_reason:'manual',resolved_at:'2026-10-29 22:45:10.000Z',claim_until:'2026-10-29 22:09:32.000Z',schedule_generation:2}
 const payload=mobile.projection(record('incident',values),'event','en','America/Fortaleza',Date.parse('2026-10-30T00:00:00Z'),'resolved','William')
 assert.equal(payload.title,'[i7y] Full disk ✅')
 assert.equal(payload.resource,'coin.hospic.io: Full disk — Incident resolved by William at {deadline}.')
 assert.equal(payload.deadline_at,'2026-10-29T22:45:10.000Z')
 const notice=record('notice',{organization:'org',kind:'resolved',valid:true,sequence:2,schedule_generation:2}),device=record('device',{active:true,start_sequence:0})
 assert.equal(mobile.eligible(notice,record('incident',values),device,Date.now()),true)
 assert.equal(mobile.eligible(notice,record('incident',{...values,status:'open'}),device,Date.now()),false)
})
