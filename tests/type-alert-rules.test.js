import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'

const source=readFileSync(new URL('../apps/backend/hooks/lib/alerts.js',import.meta.url),'utf8')
const fixtureSource=readFileSync(new URL('./alerts-engine.test.js',import.meta.url),'utf8')
const start=Date.parse('2026-10-28T12:00:00Z')
const factory=vm.runInNewContext('('+fixtureSource.slice(fixtureSource.indexOf('function fixture()'),fixtureSource.indexOf('\ntest('))+')',{source,vm,assert,start})
function fixture() {
  const f=factory()
  f.app.delete=record=>{const list=f.all(record.table);list.splice(list.indexOf(record),1)}
  const migration={module:{exports:{}},__hooks:'hooks',require:()=>f.engine}
  vm.runInNewContext(readFileSync(new URL('../apps/backend/hooks/lib/alerts-migration.js',import.meta.url),'utf8'),migration)
  return {...f,migration:migration.module.exports}
}
const declaration=(changes={})=>({model_version:2,name:'Memory',target_type:'server',condition:{metric:'host.memory_percent',operator:'gt',value:80,critical_value:90},severity:'warning',duration_seconds:0,reminder_intervals:{warning:1800,critical:300},enabled:true,exclusions:[],...changes})
const exclusion={resource_type:'server',resource_id:'server',reason:'Known accepted saturation'}
function second(f,org='org') {f.add('workspaces','workspace2',{organization:org});f.add('servers','server2',{workspace:'workspace2',name:'Second'});f.add('server_agents','agent2',{server:'server2',created:new Date(start).toISOString()})}
function send(f,id,at,host) {f.engine.evaluateSnapshot(f.app,id,f.snapshot(start+at,{host}),{applied:true,containers:{},missing:[]},start+at)}
const memory=value=>({memory_total_bytes:100,memory_available_bytes:100-value,cpu_percent:95,disks:[{path:'/',total_bytes:100,available_bytes:5}]})

test('type rules include future workspaces and containers while isolating organizations',()=>{
 const f=fixture();f.engine.saveRule(f.app,'org','memory',declaration(),'user',start)
 second(f);send(f,'server2',1000,memory(95));assert.equal(f.open().length,1)
 f.add('workspaces','foreign',{organization:'other'});f.add('servers','foreign-server',{workspace:'foreign'});send(f,'foreign-server',1000,memory(95));assert.equal(f.open().length,1)
 const container=f.engine.saveRule(f.app,'org','container',declaration({target_type:'container',severity:'critical',condition:{metric:'container.state',operator:'eq',value:'exited'},reminder_intervals:{critical:1800}}),'user',start)
 f.add('projects','project2',{server:'server2'});f.add('containers','container2',{project:'project2',name:'new'})
 f.engine.evaluateSnapshot(f.app,'server2',f.snapshot(start+2000,{containers:[{name:'new',state:'exited'}]}),{applied:true,containers:{new:'container2'},missing:[]},start+2000)
 assert.ok(f.open().some(row=>row.get('rule')===container.id && row.get('resource_id')==='container2'))
})

test('exclusion cancels only that rule/resource and keeps unrelated evaluation and notices',()=>{
 const f=fixture();second(f)
 const body=declaration(),rule=f.engine.saveRule(f.app,'org','memory',body,'user',start)
 const cpu=f.engine.saveRule(f.app,'org','cpu',declaration({name:'CPU',condition:{metric:'host.cpu_percent',operator:'gt',value:80,critical_value:90}}),'user',start)
 send(f,'server',1000,memory(95));send(f,'server2',1000,memory(95))
 const jack=f.open().find(row=>row.get('rule')===rule.id && row.get('resource_id')==='server')
 const other=f.open().find(row=>row.get('rule')===rule.id && row.get('resource_id')==='server2'),state=f.engine.states(f.app,rule).find(row=>row.get('resource_id')==='server2'),before=state.getString('data'),version=other.get('version')
 f.engine.saveRule(f.app,'org','memory',{...body,exclusions:[exclusion]},'user',start+2000)
 assert.equal(jack.get('resolution_reason'),'resource_excluded');assert.equal(other.get('version'),version);assert.equal(state.getString('data'),before)
 assert.ok(f.open().some(row=>row.get('rule')===cpu.id && row.get('resource_id')==='server'))
 f.engine.tick(f.app,start+400000)
 assert.ok(!f.engine.validNotifications(f.app,'org',0,100,start+400000).items.some(item=>item.incident_id===jack.id))
 assert.equal(f.engine.exclusions(f.app,rule)[0].reason,exclusion.reason)
 assert.throws(()=>f.engine.saveRule(f.app,'org','invalid',declaration({exclusions:[{...exclusion,resource_id:'outside'}]}),'user',start),/organization/)
})

test('reinclusion requires post-inclusion samples and a new per-resource confirmation window',()=>{
 const f=fixture(),body=declaration({duration_seconds:300}),rule=f.engine.saveRule(f.app,'org','memory',body,'user',start)
 send(f,'server',1000,memory(95));send(f,'server',301000,memory(95));assert.equal(f.open().length,1)
 f.engine.saveRule(f.app,'org','memory',{...body,exclusions:[exclusion]},'user',start+302000)
 const revision=rule.get('revision')
 f.engine.saveRule(f.app,'org','memory',body,'user',start+400000);assert.equal(rule.get('revision'),revision)
 send(f,'server',350000,memory(95));assert.equal(f.open().length,0)
 send(f,'server',401000,memory(95));send(f,'server',700000,memory(95));assert.equal(f.open().length,0)
 send(f,'server',701000,memory(95));assert.equal(f.open().length,1)
})

test('severity cadence changes on the same incident and respects claims and cadence edits',()=>{
 const f=fixture(),body=declaration({condition:{metric:'host.disk_percent',operator:'gt',value:80,critical_value:90}}),rule=f.engine.saveRule(f.app,'org','disk',body,'user',start)
 const disk=value=>({disks:[{path:'/',total_bytes:100,available_bytes:100-value}]})
 send(f,'server',1000,disk(85));const incident=f.open()[0],id=incident.id
 assert.equal(incident.get('reminder_seconds'),1800)
 send(f,'server',2000,disk(95));assert.equal(incident.id,id);assert.equal(incident.get('reminder_seconds'),300);assert.equal(Date.parse(incident.get('next_reminder_at')),start+302000)
 const deadline=new Date(start+900000).toISOString();f.engine.claim(f.app,incident,'owner',deadline,incident.get('version'),start+3000)
 send(f,'server',4000,disk(85));assert.equal(incident.get('reminder_seconds'),1800);assert.equal(incident.get('claim_until'),deadline)
 const revision=rule.get('revision');f.engine.saveRule(f.app,'org','disk',{...body,reminder_intervals:{warning:600,critical:60}},'user',start+5000)
 assert.equal(rule.get('revision'),revision);assert.equal(incident.get('reminder_seconds'),600);assert.equal(incident.get('assignee'),'owner')
 assert.ok(!f.engine.validNotifications(f.app,'org',0,100,start+6000).items.some(item=>item.kind==='reminder'))
})

test('no communication opens from the scheduler for stale enrolled servers and recovers on fresh contact',()=>{
 const f=fixture();f.app.findRecordById('servers','server').set('telemetry',{observed_at:new Date(start+1000).toISOString()})
 const rule=f.engine.saveRule(f.app,'org','communication',declaration({severity:'critical',condition:{metric:'server.no_communication_seconds',operator:'gte',value:900},reminder_intervals:{critical:1800}}),'user',start+86400000)
 f.engine.tick(f.app,start+86400000);assert.equal(f.open().length,1);const incident=f.open()[0];assert.equal(incident.get('rule'),rule.id)
 send(f,'server',86401000,memory(40));assert.equal(f.open().length,0);assert.equal(incident.get('resolution_reason'),'recovered')
 f.engine.tick(f.app,start+86401000+899000);assert.equal(f.open().length,0)
 f.engine.tick(f.app,start+86401000+900000);assert.equal(f.open().length,1)
})

test('migration preserves compatible incident IDs and claims, excludes Jack and leaves GCP untouched',()=>{
 const f=fixture();second(f)
 const legacy=(workspace,metric)=>({name:metric,scope_type:'workspace',scope_id:workspace,severity:'warning',condition:{metric,operator:'gt',value:80,critical_value:90},duration_seconds:0,reminder_seconds:900,enabled:true})
 for(const workspace of ['workspace','workspace2'])for(const metric of ['host.cpu_percent','host.memory_percent','host.disk_percent'])f.engine.saveRule(f.app,'org',workspace+'-'+metric,legacy(workspace,metric),'user',start)
 send(f,'server',1000,{...memory(95),cpu_percent:0,disks:[{path:'/',total_bytes:100,available_bytes:90}]})
 send(f,'server2',1000,{...memory(20),cpu_percent:0,disks:[{path:'/',total_bytes:100,available_bytes:15}]})
 const jack=f.open().find(row=>row.get('resource_id')==='server'),disk=f.open().find(row=>row.get('resource_id')==='server2'),diskId=disk.id
 const deadline=new Date(start+3600000).toISOString();f.engine.claim(f.app,disk,'owner',deadline,disk.get('version'),start+1500)
 const external=f.add('incidents','gcp',{organization:'org',origin:'gcp',status:'open',title:'External',version:7})
 const settings={exclusions:[{metric:'host.memory_percent',...exclusion}]},plan=f.migration.preview(f.app,'org',settings)
 assert.equal(plan.can_apply,true);assert.equal(plan.source_count,6);assert.equal(plan.destination_count,4)
 const result=f.migration.apply(f.app,'org',plan,'user',start+2000)
 assert.equal(jack.get('resolution_reason'),'resource_excluded');assert.equal(disk.id,diskId);assert.equal(disk.get('status'),'open');assert.equal(disk.get('assignee'),'owner');assert.equal(disk.get('claim_until'),deadline);assert.equal(external.get('version'),7)
 assert.equal(result.incidents_preserved[0],diskId);assert.equal(result.incidents_excluded[0],jack.id)
 assert.equal(f.all('alert_rules').filter(row=>row.get('archived')!==true).length,4)
 assert.equal(f.migration.preview(f.app,'org',{}).can_apply,false)
})

test('migration reports conflicting definitions rather than silently activating or changing them',()=>{
 const f=fixture()
 f.rule({condition:{metric:'host.memory_percent',operator:'gt',value:80}},'a')
 f.rule({condition:{metric:'host.memory_percent',operator:'gt',value:90},enabled:false},'b')
 const plan=f.migration.preview(f.app,'org',{})
 assert.equal(plan.can_apply,false);assert.ok(plan.conflicts.length>0)
 assert.throws(()=>f.migration.apply(f.app,'org',plan,'user',start),/conflicts/)
})
