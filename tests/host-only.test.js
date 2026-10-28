import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {serverStats} from '../apps/web/src/telemetry-summary.js'
const context={module:{exports:{}}}
vm.runInNewContext(readFileSync(new URL('../apps/backend/hooks/lib/telemetry.js',import.meta.url),'utf8'),context)
const {validate,reconcile}=context.module.exports
test('host-only reports update server without reading or modifying inventory',()=>{
 const data={version:1,sample_id:'host-only-sample-1234',observed_at:new Date().toISOString(),collection_mode:'host',host:{cpu_percent:3},agent_version:'test',docker_complete:false,discovery_complete:false,projects:[],containers:[],errors:[]}
 validate(data)
 const values={telemetry:'{}'},server={getString:key=>values[key]||'',set:(key,value)=>{values[key]=value}}
 let saved=false
 const app={findRecordById:()=>server,save:record=>{assert.equal(record,server);saved=true},findRecordsByFilter:()=>{throw Error('inventory accessed')}}
 reconcile(app,'server',data)
 assert.equal(saved,true);assert.equal(values.telemetry.state,'healthy');assert.equal(values.telemetry.collection_mode,'host');assert.equal(values.inventory_known,undefined)
 assert.throws(()=>validate({...data,docker_complete:true}))
 assert.throws(()=>validate({...data,projects:[{key:'unexpected',name:'unexpected',path:'/'}]}))
 assert.equal(serverStats(values.telemetry,[]).hostOnly,true)
})
