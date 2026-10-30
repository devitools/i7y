import test from 'node:test'
import assert from 'node:assert/strict'
import { alertTargetChoices, filterAlertTargets, emptyTargetFilters } from '../apps/web/src/alert-targets.ts'

const inventory = {
  workspace: [{id:'wa',login:'Produ\u00e7\u00e3o',provider:'Cloud A'},{id:'wb',login:'Staging',provider:'Cloud B'}],
  server: [
    {id:'sa',name:'database',ip:'10.20.0.1',workspace:'wa',type:'VPS',telemetry:{host:{operating_system:{pretty_name:'Windows Server 2019'}}}},
    {id:'sb',name:'database',ip:'10.30.0.1',workspace:'wb',type:'VPS',telemetry:{host:{operating_system:{name:'Ubuntu',version_id:'24.04'}}}},
    {id:'sc',name:'legacy',workspace:'wa',type:'Dedicated'},
  ],
  project: [{id:'pa',name:'Payments',server:'sa'},{id:'pb',name:'Demo',server:'sb'}],
  container: [{id:'ca',name:'web',project:'pa',image:'nginx:1.27'},{id:'cb',name:'web',project:'pb',image:'nginx:1.26'}],
}
const ids = rows => rows.map(row=>row.value)

test('destination search ignores accents and case and matches contextual IP, project and image',()=>{
  assert.deepEqual(ids(filterAlertTargets(alertTargetChoices(inventory,'server'),emptyTargetFilters(),'PRODUCAO 10.20')),['sa'])
  assert.deepEqual(ids(filterAlertTargets(alertTargetChoices(inventory,'container'),emptyTargetFilters(),'payments nginx:1.27')),['ca'])
  assert.deepEqual(ids(filterAlertTargets(alertTargetChoices(inventory,'container'),emptyTargetFilters(),'10.30.0.1')),['cb'])
  assert.deepEqual(ids(filterAlertTargets(alertTargetChoices(inventory,'workspace'),emptyTargetFilters(),'cloud b')),['wb'])
})

test('server filters intersect workspace, type and operating system without mutating the catalog',()=>{
  const choices=alertTargetChoices(inventory,'server')
  const filters={...emptyTargetFilters(),workspace:'wa',type:'VPS',os:'Windows Server 2019'}
  assert.deepEqual(ids(filterAlertTargets(choices,filters)),['sa'])
  assert.deepEqual(filterAlertTargets(choices,{...filters,workspace:'wb'}),[])
  assert.equal(filterAlertTargets(choices,emptyTargetFilters(),'').length,3)
  assert.equal(choices.length,3)
})

test('container parent filters follow project-server-workspace relations and distinguish repeated names',()=>{
  const choices=alertTargetChoices(inventory,'container')
  assert.deepEqual(ids(filterAlertTargets(choices,{...emptyTargetFilters(),workspace:'wa',server:'sa',project:'pa'})),['ca'])
  assert.deepEqual(filterAlertTargets(choices,{...emptyTargetFilters(),workspace:'wa',server:'sb'}),[])
  assert.match(choices.find(row=>row.value==='ca').description,/database.*Payments.*nginx:1.27/)
  assert.match(choices.find(row=>row.value==='cb').description,/database.*Demo.*nginx:1.26/)
})

test('records missing telemetry or a parent remain searchable by their own identity',()=>{
  const choices=alertTargetChoices({...inventory,container:[{id:'orphan',name:'worker',project:'missing',image:'jobs:latest'}]},'container')
  assert.deepEqual(ids(filterAlertTargets(choices,emptyTargetFilters(),'jobs:latest')),['orphan'])
  assert.deepEqual(filterAlertTargets(choices,{...emptyTargetFilters(),workspace:'wa'}),[])
  assert.equal(alertTargetChoices(inventory,'server').find(row=>row.value==='sc').os,'')
})

test('identical destination names and context retain a visible identity discriminator',()=>{
  const choices=alertTargetChoices({...inventory,container:[{id:'one',name:'web',project:'pa',image:'nginx:1.27'},{id:'two',name:'web',project:'pa',image:'nginx:1.27'}]},'container')
  assert.match(choices[0].description,/10\.20\.0\.1/)
  assert.notEqual(choices[0].description,choices[1].description)
  assert.match(choices.find(row=>row.value==='one').description,/one$/)
  assert.match(choices.find(row=>row.value==='two').description,/two$/)
})
