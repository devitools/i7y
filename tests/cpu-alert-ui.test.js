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

const cpuRule=()=>({key:'cpu',name:'CPU saturation',scope_type:'server',scope_id:'server-a',target_type:'server',severity:'warning',condition:{metric:'host.cpu_percent',operator:'gt',value:80,critical_value:90},duration_seconds:300,reminder_seconds:900,enabled:true})
const source=readFileSync(new URL('../apps/web/src/components/AlertsPage.vue',import.meta.url),'utf8')

async function page(t,options={}){
  const {action='edit',diskCapability=true}=options
  const cpuCapability=Object.hasOwn(options,'cpuCapability')?options.cpuCapability:true
  const scope=effectScope(),calls=[]
  const context={computed,ref,watch,onUnmounted:()=>{},defineProps:()=>({route:{action,key:'cpu'},canEdit:true}),useQuasar:()=>({notify:()=>{}}),activeOrganization:ref('org-a'),t:key=>en[key]||key,locale:ref('en'),leadingRowActions:rows=>rows,emptyTargetFilters:()=>({}),alertTargetChoices:()=>[],filterAlertTargets:()=>[],inventoryLabel:row=>row.name||row.id,window:{location:{hash:''}},pb:{collection:()=>({getFullList:async()=>[]})}}
  context.alertsApi={
    metrics:async()=>({items:[{id:'host.cpu_percent',target_type:'server',operators:['gt','gte'],supports_critical_value:cpuCapability},{id:'host.disk_percent',target_type:'server',operators:['gt','gte'],supports_critical_value:diskCapability}]}),
    rule:async()=>cpuRule(),
    saveRule:async(key,body)=>{calls.push({kind:'save',key,body});return body},
    simulate:async body=>{calls.push({kind:'simulate',body});return {items:[{result:'true',severity:'critical',value:95}],totalItems:1}},
  }
  const script=parse(source).descriptor.scriptSetup.content.replace(/^import .*\n/gm,'')
  const expose='\nglobalThis.page={form,preview,error,criticalEligible,criticalSupported,hasCritical,payload,validateCritical,conditionLabel,load,save,simulate}'
  scope.run(()=>vm.runInNewContext(ts.transpileModule(script+expose,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context))
  t.after(()=>scope.stop())
  await context.page.load()
  return {...context.page,calls}
}

test('CPU create and edit preserve both thresholds and five-minute confirmation',async t=>{
  for(const action of ['new','edit']){
    const form=await page(t,{action})
    if(action==='new')Object.assign(form.form.value,cpuRule())
    assert.equal(form.criticalEligible.value,true)
    assert.equal(form.form.value.condition.critical_value,90)
    assert.equal(form.payload().duration_seconds,300)
    await form.save()
    assert.equal(form.calls[0].body.condition.metric,'host.cpu_percent')
    assert.equal(form.calls[0].body.condition.value,80)
    assert.equal(form.calls[0].body.condition.critical_value,90)
    assert.equal(form.calls[0].body.duration_seconds,300)
  }
})

test('CPU needs explicit boolean capability on the exact selected metric',async t=>{
  for(const cpuCapability of [false,undefined,null,'true',1]){
    const form=await page(t,{cpuCapability,diskCapability:true})
    assert.equal(form.criticalSupported.value,false)
    await form.save()
    await form.simulate()
    assert.equal(form.calls.length,0)
    assert.equal(form.error.value,en['alerts.criticalUnsupported'])
    assert.equal(form.form.value.condition.critical_value,90)
  }
  const form=await page(t,{cpuCapability:true,diskCapability:false})
  assert.equal(form.validateCritical(),true)
  form.form.value.condition.metric='host.disk_percent'
  assert.equal(form.criticalEligible.value,true)
  assert.equal(form.criticalSupported.value,false)
  assert.equal(form.form.value.condition.critical_value,90)
  await form.save()
  assert.equal(form.calls.length,0)
})

test('only CPU, memory and disk retain the optional critical band when changing metrics',async t=>{
  const form=await page(t)
  form.form.value.condition.metric='host.disk_percent'
  assert.equal(form.payload().condition.critical_value,90)
  assert.equal(form.payload().duration_seconds,300)
  form.form.value.condition.metric='host.cpu_percent'
  assert.equal(form.payload().condition.critical_value,90)
  form.form.value.condition.metric='container.memory_percent'
  assert.equal(form.hasCritical.value,false)
  assert.equal('critical_value' in form.payload().condition,false)
})

test('CPU preview reports the current band without claiming duration has elapsed',async t=>{
  const form=await page(t)
  await form.simulate()
  assert.equal(form.calls[0].body.duration_seconds,300)
  assert.equal(form.preview.value.items[0].severity,'critical')
  assert.match(en['alerts.previewHelp'],/ignores minimum duration/)
  assert.match(en['alerts.previewHelp'],/does not confirm sustained warning or critical entry/)
  assert.ok(source.includes("t('alerts.previewHelp')"))
})

test('CPU table and native review show duration independently for both severity thresholds',async t=>{
  const form=await page(t)
  assert.ok(form.conditionLabel(cpuRule()).includes(en['alerts.confirmationSummary'].replace('{seconds}','300')))
  const request={tool:'save_alert_rule',arguments:{rule:cpuRule()}}
  const rows=actionSummary(request)
  assert.ok(rows.some(row=>row.label==='Warning threshold'&&row.value==='> 80%'))
  assert.ok(rows.some(row=>row.label==='Critical threshold'&&row.value==='> 90%'))
  assert.ok(rows.some(row=>row.label==='Confirmation per severity (seconds)'&&row.value==='300'))
  assert.ok(actionDetails(request).some(row=>row.labels.at(-1)==='Confirmation per severity (seconds)'&&row.value==='300'))
  request.arguments.rule.condition.metric='host.disk_percent'
  request.arguments.rule.duration_seconds=0
  assert.ok(actionSummary(request).some(row=>row.label==='Duration (seconds)'&&row.value==='0'))
  request.arguments.rule.duration_seconds=300
  assert.equal(actionSummary(request).some(row=>row.label==='Confirmation per severity (seconds)'),false)
  assert.equal(actionDetails(request).some(row=>row.labels.at(-1)==='Confirmation per severity (seconds)'),false)
  assert.equal(form.conditionLabel(request.arguments.rule).includes(en['alerts.confirmationSummary'].replace('{seconds}','300')),false)
})

test('duration and compatibility explanations are localized without disk-only wording',()=>{
  for(const dictionary of [en,ptBR,uk]){
    assert.ok(dictionary['alerts.confirmationSummary'].includes('{seconds}'))
    for(const key of ['alerts.criticalHelp','alerts.durationHelp','alerts.cpuCriticalHelp','alerts.cpuDurationHelp','alerts.previewHelp'])assert.ok(dictionary[key]?.trim(),key)
  }
  assert.doesNotMatch(en['alerts.criticalUnsupported'],/disk/)
  for(const dictionary of [mcpEn,mcpPtBR,mcpUk])assert.ok(dictionary['Confirmation per severity (seconds)']?.trim())
})
