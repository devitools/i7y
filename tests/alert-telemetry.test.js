import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'

test('enrollment rechecks current user and server organization inside its transaction',()=>{
  const routes=new Map(),checks=[],writes=[]
  let transferred=false,demoted=false
  const server={id:'server',organization:'source'},user={id:'user'}
  const tx={findRecordById:table=>table==='servers'?{...server,organization:transferred?'destination':'source'}:{...user,demoted},findRecordsByFilter:()=>[],findCollectionByNameOrId:()=>({}),save:()=>writes.push('saved')}
  const lib={organization:(_app,record)=>record.organization,requireRole:(e,org)=>{checks.push({transaction:e.app===tx,org});if(org!=='source'||e.auth.demoted)throw Error('Denied')}}
  const context={routerAdd:(method,path,handler)=>routes.set(method+' '+path,handler),cronAdd:()=>{},__hooks:'/hooks',require:()=>lib,$apis:{requireAuth:()=>{},bodyLimit:()=>{}},$security:{randomString:()=>'',sha256:()=>''},Record:class {set(){}}}
  vm.runInNewContext(readFileSync(new URL('../apps/backend/hooks/telemetry.pb.js',import.meta.url),'utf8'),context)
  const app={findRecordById:()=>server,runInTransaction:fn=>{transferred=true;fn(tx)}}
  const e={app,auth:user,requestInfo:()=>({body:{server:'server'}}),response:{header:()=>({set(){}})},json:()=>({})}
  const enroll=routes.get('POST /api/i7y/agents')
  assert.throws(()=>enroll(e),/Denied/)
  assert.deepEqual(checks,[{transaction:false,org:'source'},{transaction:true,org:'destination'}])
  assert.deepEqual(writes,[])
  checks.length=0;transferred=false
  app.runInTransaction=fn=>{demoted=true;fn(tx)}
  assert.throws(()=>enroll(e),/Denied/)
  assert.deepEqual(writes,[])
  assert.equal(checks.at(-1).transaction,true)
})

test('an ambiguous listed project cannot turn present containers into missing evidence',()=>{
  const context={module:{exports:{}}}
  vm.runInNewContext(readFileSync(new URL('../apps/backend/hooks/lib/telemetry.js',import.meta.url),'utf8'),context)
  const row=(id,values)=>({id,getString:key=>typeof values[key]==='object'?JSON.stringify(values[key]):values[key]||'',set:(key,value)=>{values[key]=value}})
  const server=row('s',{}),projects=[row('p1',{path:'/same',name:'one'}),row('p2',{path:'/same',name:'two'})]
  const container=row('c',{project:'p1',name:'web',telemetry:{state:'running'}})
  const app={findRecordById:()=>server,findRecordsByFilter:table=>table==='projects'?projects:[container],save:()=>{}}
  const result=context.module.exports.reconcile(app,'s',{observed_at:'2026-10-29T00:00:00Z',host:{},errors:[],docker_complete:true,discovery_complete:true,projects:[{key:'raw',path:'/same',name:'one'}],containers:[{name:'web',project_key:'raw',state:'running'}]})
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{applied:true,containers:{},missing:[]})
  assert.equal(JSON.parse(container.getString('telemetry')).state,'running')
})
