import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {parse} from '@vue/compiler-sfc'
import {computed,ref,watch,effectScope} from 'vue'
import {actionSummary,actionDetails} from '../apps/web/src/mcp-action-summary.ts'
import en from '../apps/web/src/locales/en/alerts.ts'
import ptBR from '../apps/web/src/locales/pt-BR/alerts.ts'
import uk from '../apps/web/src/locales/uk/alerts.ts'
import mcpEn from '../apps/web/src/locales/en/mcp.ts'
import mcpPtBR from '../apps/web/src/locales/pt-BR/mcp.ts'
import mcpUk from '../apps/web/src/locales/uk/mcp.ts'

const diskRule=()=>({key:'disk',name:'Disk capacity',scope_type:'server',scope_id:'server-a',target_type:'server',severity:'warning',condition:{metric:'host.disk_percent',operator:'gt',value:80,critical_value:90,disk_path:'*'},duration_seconds:0,reminder_seconds:900,enabled:true})
const source=readFileSync(new URL('../apps/web/src/components/AlertsPage.vue',import.meta.url),'utf8')

async function page(t,{rule=diskRule(),supported=true,simulate,action='edit'}={}){
  const scope=effectScope(),calls=[]
  const context={computed,ref,watch,onUnmounted:()=>{},defineProps:()=>({route:{action,key:'disk'},canEdit:true}),useQuasar:()=>({notify:()=>{}}),activeOrganization:ref('org-a'),t:key=>en[key]||key,locale:ref('en'),leadingRowActions:rows=>rows,emptyTargetFilters:()=>({}),alertTargetChoices:()=>[],filterAlertTargets:()=>[],inventoryLabel:row=>row.name||row.id,window:{location:{hash:''}},pb:{collection:()=>({getFullList:async()=>[]})}}
  context.alertsApi={
    metrics:async()=>({items:[{id:'host.disk_percent',target_type:'server',unit:'%',operators:['gt','gte','lt'],...(supported?{supports_critical_value:true}:{})},{id:'host.cpu_percent',target_type:'server',operators:['gt']}]}),
    rule:async()=>structuredClone(rule),
    saveRule:async(key,body)=>{calls.push({kind:'save',key,body});return body},
    simulate:async body=>{calls.push({kind:'simulate',body});return simulate?simulate(body):{items:[{resource_type:'server',resource_id:'server-a',result:'true',value:95,severity:'critical'}],totalItems:1}},
  }
  const script=parse(source).descriptor.scriptSetup.content.replace(/^import .*\n/gm,'')
  const expose='\nglobalThis.page={form,metrics,preview,error,criticalEligible,criticalSupported,hasCritical,payload,validateCritical,criticalThreshold,conditionLabel,severityLabel,load,save,simulate}'
  scope.run(()=>vm.runInNewContext(ts.transpileModule(script+expose,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context))
  t.after(()=>scope.stop())
  await context.page.load()
  return {...context.page,calls,context}
}

test('disk thresholds survive edit, payload, save and simulation without changing old rules',async t=>{
  const form=await page(t)
  assert.equal(form.form.value.condition.critical_value,90)
  assert.equal(form.payload().condition.critical_value,90)
  await form.save()
  await form.simulate()
  assert.deepEqual(form.calls.map(call=>call.body.condition.critical_value),[90,90])
  assert.equal(form.preview.value.items[0].severity,'critical')
  const legacy=diskRule()
  delete legacy.condition.critical_value
  const old=await page(t,{rule:legacy,supported:false})
  assert.equal('critical_value' in old.payload().condition,false)
  await old.save()
  assert.equal('critical_value' in old.calls[0].body.condition,false)
  old.form.value.condition.critical_value=null
  assert.equal('critical_value' in old.payload().condition,false)
})

test('eligible disk rules can add or remove the optional critical band',async t=>{
  const rule=diskRule()
  delete rule.condition.critical_value
  const form=await page(t,{rule})
  form.form.value.condition.critical_value=95
  assert.equal(form.validateCritical(),true)
  assert.equal(form.payload().condition.critical_value,95)
  form.form.value.condition.operator='gte'
  assert.equal(form.payload().condition.critical_value,95)
  form.form.value.condition.critical_value=''
  assert.equal(form.hasCritical.value,false)
  assert.equal('critical_value' in form.payload().condition,false)
  const created=await page(t,{action:'new'})
  Object.assign(created.form.value,diskRule())
  await created.save()
  assert.equal(created.calls[0].body.condition.value,80)
  assert.equal(created.calls[0].body.condition.critical_value,90)
})

test('changing metric, comparison or base severity clears an ineligible critical band',async t=>{
  for(const change of [form=>{form.condition.metric='container.memory_percent'},form=>{form.condition.operator='lt'},form=>{form.severity='critical'}]){
    const form=await page(t)
    change(form.form.value)
    assert.equal('critical_value' in form.form.value.condition,false)
    assert.equal('critical_value' in form.payload().condition,false)
  }
})

test('invalid critical bands block save and simulation before any API write',async t=>{
  for(const value of [80,79,100.01,'invalid']){
    const form=await page(t)
    form.form.value.condition.critical_value=value
    await form.save()
    await form.simulate()
    assert.equal(form.calls.length,0)
    assert.equal(form.error.value,en['alerts.criticalRange'])
  }
  const form=await page(t)
  form.form.value.condition.critical_value=100
  assert.equal(form.validateCritical(),true)
})

test('old backend capability gaps preserve critical configuration and fail closed',async t=>{
  const form=await page(t,{supported:false})
  assert.equal(form.form.value.condition.critical_value,90)
  assert.equal(form.criticalSupported.value,false)
  await form.save()
  await form.simulate()
  assert.equal(form.calls.length,0)
  assert.equal(form.error.value,en['alerts.criticalUnsupported'])
  assert.equal(form.form.value.condition.critical_value,90)
})

test('a late simulation cannot display severity for thresholds that have changed',async t=>{
  let finish
  const response=new Promise(resolve=>{finish=resolve})
  const form=await page(t,{simulate:()=>response})
  const pending=form.simulate()
  form.form.value.condition.critical_value=95
  finish({items:[{result:'true',severity:'critical'}],totalItems:1})
  await pending
  assert.equal(form.preview.value,null)
})

test('table and native approval expose warning and critical thresholds as labeled values',async t=>{
  const form=await page(t)
  const label=form.conditionLabel(diskRule())
  assert.match(label,/Warning:.*80%/)
  assert.match(label,/Critical:.*90%/)
  assert.equal(form.severityLabel(diskRule()),en['alerts.escalatingSeverity'])
  const request={tool:'save_alert_rule',arguments:{key:'disk',rule:diskRule()}}
  const rows=actionSummary(request)
  assert.deepEqual(rows.filter(row=>row.label.includes('threshold')),[{label:'Warning threshold',value:'> 80%'},{label:'Critical threshold',value:'> 90%'}])
  const details=actionDetails(request)
  assert.ok(details.some(row=>row.labels.at(-1)==='Warning threshold (%)'&&row.value==='80'))
  assert.ok(details.some(row=>row.labels.at(-1)==='Critical threshold (%)'&&row.value==='90'))
  assert.ok(source.includes('severityColor(item.severity)'))
  assert.ok(source.includes('criticalEligible && (criticalSupported || hasCritical)'))
})

test('escalation controls, approval labels and severity transition timeline are localized',()=>{
  for(const dictionary of [en,ptBR,uk])for(const key of ['alerts.criticalThreshold','alerts.criticalHelp','alerts.criticalRange','alerts.criticalUnsupported','alerts.escalatingSeverity','incidents.event.severity_changed'])assert.ok(dictionary[key]?.trim(),key)
  for(const dictionary of [mcpEn,mcpPtBR,mcpUk])for(const key of ['Warning threshold','Critical threshold','Warning threshold (%)','Critical threshold (%)'])assert.ok(dictionary[key]?.trim(),key)
  const timeline=readFileSync(new URL('../apps/web/src/components/IncidentsPage.vue',import.meta.url),'utf8')
  assert.ok(timeline.includes("t('incidents.event.'+event.kind)"))
})
