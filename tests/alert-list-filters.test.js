import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {parse} from '@vue/compiler-sfc'
import {computed,ref,watch,effectScope} from 'vue'
import en from '../apps/web/src/locales/en/alerts.ts'

const source=readFileSync(new URL('../apps/web/src/components/AlertsPage.vue',import.meta.url),'utf8')

async function page(t,options={}){
  const action=''
  let currentRules=options.rules||fixtureRules()
  const scope=effectScope(),calls=[]
  const context={computed,ref,watch,onUnmounted:()=>{},defineProps:()=>({route:{action,key:'memory'},canEdit:true}),useQuasar:()=>({notify:()=>{}}),activeOrganization:ref('org-a'),t:key=>en[key]||key,locale:ref('en'),leadingRowActions:rows=>rows,emptyTargetFilters:()=>({}),alertTargetChoices:()=>[],filterAlertTargets:()=>[],inventoryLabel:row=>row.name||row.id,window:{location:{hash:''}},pb:{collection:()=>({getFullList:async()=>[]})}}
  context.alertsApi={
    metrics:async()=>({items:[{id:'host.memory_percent',target_type:'server',operators:['gt','gte'],supports_critical_value:true},{id:'host.cpu_percent',target_type:'server',operators:['gt','gte'],supports_critical_value:true},{id:'host.disk_percent',target_type:'server',operators:['gt','gte'],supports_critical_value:true}]}),
    rules:async()=>({items:currentRules}),
    saveRule:async(key,body)=>{calls.push({kind:'save',key,body});return body},
    simulate:async body=>{calls.push({kind:'simulate',body});return {items:[{result:'true',severity:'critical',value:95}],totalItems:1}},
  }
  const script=parse(source).descriptor.scriptSetup.content.replace(/^import .*\n/gm,'')
  const expose='\nglobalThis.page={rules,metrics,inventory,filteredRules,ruleSearch,ruleStatus,ruleCondition,ruleTarget,conditionFilterOptions,targetFilterOptionsForRules,rulePagination,load}'
  scope.run(()=>vm.runInNewContext(ts.transpileModule(script+expose,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context))
  t.after(()=>scope.stop())
  await context.page.load()
  return {...context.page,calls,organization:context.activeOrganization,setRules:value=>{currentRules=value}}
}

const makeRule=(key,metric,scope_type,scope_id,enabled=true)=>({key,name:key,condition:{metric,operator:'gt',value:80},scope_type,scope_id,enabled})
const fixtureRules=()=>[
  makeRule('cpu-alpha','host.cpu_percent','server','a'),
  makeRule('memory-alpha','host.memory_percent','server','a'),
  makeRule('disk-beta','host.disk_percent','server','b',false),
  makeRule('memory-workspace','host.memory_percent','workspace','a'),
  makeRule('memory-container','host.memory_percent','container','c',false),
  makeRule('legacy','custom.metric','server','b'),
]
const keys=form=>Array.from(form.filteredRules.value,row=>row.key)

test('condition and scoped target choices use stable IDs and readable labels',async t=>{
  const form=await page(t)
  form.inventory.value={workspace:[{id:'a',name:'Production'}],server:[{id:'a',name:'Shared'},{id:'b',name:'Shared'}],container:[{id:'c',name:'Shared'}],project:[]}
  assert.deepEqual(Array.from(form.conditionFilterOptions.value,row=>row.value).sort(),['custom.metric','host.cpu_percent','host.disk_percent','host.memory_percent'])
  assert.equal(form.conditionFilterOptions.value.find(row=>row.value==='host.memory_percent').label,en['alerts.metric.host.memory_percent'])
  assert.equal(form.conditionFilterOptions.value.find(row=>row.value==='custom.metric').label,'custom.metric')
  const choices=form.targetFilterOptionsForRules.value
  assert.equal(choices.length,4)
  assert.equal(new Set(choices.map(row=>row.label)).size,4)
  assert.ok(choices.find(row=>row.value==='server:a').label.includes('Shared'))
  assert.ok(choices.find(row=>row.value==='workspace:a').label.includes('Workspace'))
})

test('condition and target filters combine with search and status and clear independently',async t=>{
  const form=await page(t)
  assert.equal(keys(form).length,6)
  form.ruleCondition.value='host.memory_percent'
  assert.deepEqual(keys(form),['memory-alpha','memory-workspace','memory-container'])
  form.ruleTarget.value='server:a'
  assert.deepEqual(keys(form),['memory-alpha'])
  form.ruleCondition.value=null
  assert.deepEqual(keys(form),['cpu-alpha','memory-alpha'])
  form.ruleTarget.value=null
  form.ruleStatus.value='disabled'
  assert.deepEqual(keys(form),['disk-beta','memory-container'])
  form.ruleCondition.value='host.memory_percent'
  assert.deepEqual(keys(form),['memory-container'])
  form.ruleSearch.value='workspace'
  assert.deepEqual(keys(form),[])
  form.ruleStatus.value='all'
  assert.deepEqual(keys(form),['memory-workspace'])
  form.ruleSearch.value=''
  form.ruleCondition.value=null
  assert.equal(keys(form).length,6)
  assert.equal(form.calls.length,0)
})

test('every list filter resets the page while retaining the selected page size',async t=>{
  const form=await page(t)
  form.rulePagination.value.rowsPerPage=25
  for(const [field,value] of [['ruleCondition','host.memory_percent'],['ruleTarget','server:a'],['ruleSearch','alpha'],['ruleStatus','enabled']]){
    form.rulePagination.value.page=4
    form[field].value=value
    assert.equal(form.rulePagination.value.page,1)
    assert.equal(form.rulePagination.value.rowsPerPage,25)
  }
})

test('rule reload clears obsolete selections and organization change clears scoped filters',async t=>{
  const form=await page(t)
  form.ruleCondition.value='custom.metric'
  form.ruleTarget.value='server:b'
  form.rulePagination.value.page=3
  form.setRules([makeRule('new-memory','host.memory_percent','server','new')])
  await form.load(true)
  assert.equal(form.ruleCondition.value,null)
  assert.equal(form.ruleTarget.value,null)
  assert.equal(form.rulePagination.value.page,1)
  assert.deepEqual(keys(form),['new-memory'])
  form.ruleCondition.value='host.memory_percent'
  form.ruleTarget.value='server:new'
  form.organization.value='org-b'
  assert.equal(form.ruleCondition.value,null)
  assert.equal(form.ruleTarget.value,null)
  assert.equal(form.calls.length,0)
})
