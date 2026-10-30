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

const memoryRule=()=>({key:'memory',name:'Memory saturation',scope_type:'server',scope_id:'server-a',target_type:'server',severity:'warning',condition:{metric:'host.memory_percent',operator:'gt',value:80,critical_value:90},duration_seconds:300,reminder_seconds:900,enabled:true})
const source=readFileSync(new URL('../apps/web/src/components/AlertsPage.vue',import.meta.url),'utf8')

async function page(t,options={}){
  const {action='edit',diskCapability=true}=options
  const memoryCapability=Object.hasOwn(options,'memoryCapability')?options.memoryCapability:true
  const scope=effectScope(),calls=[]
  const context={computed,ref,watch,onUnmounted:()=>{},defineProps:()=>({route:{action,key:'memory'},canEdit:true}),useQuasar:()=>({notify:()=>{}}),activeOrganization:ref('org-a'),t:key=>en[key]||key,locale:ref('en'),leadingRowActions:rows=>rows,emptyTargetFilters:()=>({}),alertTargetChoices:()=>[],filterAlertTargets:()=>[],inventoryLabel:row=>row.name||row.id,window:{location:{hash:''}},pb:{collection:()=>({getFullList:async()=>[]})}}
  context.alertsApi={
    metrics:async()=>({items:[{id:'host.memory_percent',target_type:'server',operators:['gt','gte'],supports_critical_value:memoryCapability},{id:'host.cpu_percent',target_type:'server',operators:['gt','gte'],supports_critical_value:true},{id:'host.disk_percent',target_type:'server',operators:['gt','gte'],supports_critical_value:diskCapability}]}),
    rule:async()=>memoryRule(),
    saveRule:async(key,body)=>{calls.push({kind:'save',key,body});return body},
    simulate:async body=>{calls.push({kind:'simulate',body});return {items:[{result:'true',severity:'critical',value:95}],totalItems:1}},
  }
  const script=parse(source).descriptor.scriptSetup.content.replace(/^import .*\n/gm,'')
  const expose='\nglobalThis.page={form,metrics,preview,error,criticalEligible,criticalSupported,hasCritical,payload,validateCritical,conditionLabel,load,save,simulate}'
  scope.run(()=>vm.runInNewContext(ts.transpileModule(script+expose,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context))
  t.after(()=>scope.stop())
  await context.page.load()
  return {...context.page,calls}
}

test('Memory create and edit preserve both thresholds and five-minute confirmation',async t=>{
  for(const action of ['new','edit']){
    const form=await page(t,{action})
    if(action==='new')Object.assign(form.form.value,memoryRule())
    assert.equal(form.criticalEligible.value,true)
    assert.equal(form.form.value.condition.critical_value,90)
    assert.equal(form.payload().duration_seconds,300)
    await form.save()
    assert.equal(form.calls[0].body.condition.metric,'host.memory_percent')
    assert.equal(form.calls[0].body.condition.value,80)
    assert.equal(form.calls[0].body.condition.critical_value,90)
    assert.equal(form.calls[0].body.duration_seconds,300)
  }
})

test('Memory needs explicit boolean capability on the exact selected metric',async t=>{
  for(const memoryCapability of [false,undefined,null,'true',1]){
    const form=await page(t,{memoryCapability,diskCapability:true})
    assert.equal(form.criticalSupported.value,false)
    await form.save()
    await form.simulate()
    assert.equal(form.calls.length,0)
    assert.equal(form.error.value,en['alerts.criticalUnsupported'])
    assert.equal(form.form.value.condition.critical_value,90)
  }
  const form=await page(t,{memoryCapability:true,diskCapability:false})
  assert.equal(form.validateCritical(),true)
  form.form.value.condition.metric='host.disk_percent'
  assert.equal(form.criticalEligible.value,true)
  assert.equal(form.criticalSupported.value,false)
  assert.equal(form.form.value.condition.critical_value,90)
  await form.save()
  assert.equal(form.calls.length,0)
})

test('only supported host metrics retain the optional critical band when changing metrics',async t=>{
  const form=await page(t)
  form.form.value.condition.metric='host.disk_percent'
  assert.equal(form.payload().condition.critical_value,90)
  assert.equal(form.payload().duration_seconds,300)
  form.form.value.condition.metric='host.memory_percent'
  assert.equal(form.payload().condition.critical_value,90)
  form.form.value.condition.metric='container.memory_percent'
  assert.equal(form.hasCritical.value,false)
  assert.equal('critical_value' in form.payload().condition,false)
})

test('Memory preview reports the current band without claiming duration has elapsed',async t=>{
  const form=await page(t)
  await form.simulate()
  assert.equal(form.calls[0].body.duration_seconds,300)
  assert.equal(form.preview.value.items[0].severity,'critical')
  assert.match(en['alerts.previewHelp'],/ignores minimum duration/)
  assert.match(en['alerts.previewHelp'],/does not confirm sustained warning or critical entry/)
  assert.ok(source.includes("t('alerts.previewHelp')"))
})

test('Memory table and native review show duration independently for both severity thresholds',async t=>{
  const form=await page(t)
  assert.ok(form.conditionLabel(memoryRule()).includes(en['alerts.confirmationSummary'].replace('{seconds}','300')))
  const request={tool:'save_alert_rule',arguments:{rule:memoryRule()}}
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
    for(const key of ['alerts.criticalHelp','alerts.durationHelp','alerts.timedCriticalHelp','alerts.timedDurationHelp','alerts.previewHelp'])assert.ok(dictionary[key]?.trim(),key)
  }
  assert.doesNotMatch(en['alerts.criticalUnsupported'],/disk/)
  for(const dictionary of [mcpEn,mcpPtBR,mcpUk])assert.ok(dictionary['Confirmation per severity (seconds)']?.trim())
})


test('memory with missing catalog row keeps configured threshold and blocks both actions',async t=>{
  const form=await page(t)
  form.metrics.value=form.metrics.value.filter(row=>row.id!=='host.memory_percent')
  assert.equal(form.criticalSupported.value,false)
  assert.equal(form.payload().condition.critical_value,90)
  await form.save()
  await form.simulate()
  assert.equal(form.calls.length,0)
  assert.equal(form.error.value,en['alerts.criticalUnsupported'])
})

test('memory independent duration help is wired to the actual Vue template',()=>{
  assert.ok(source.includes("['host.cpu_percent','host.memory_percent'].includes(form.condition.metric)&&hasCritical?'alerts.timedCriticalHelp'"))
  assert.ok(source.includes("['host.cpu_percent','host.memory_percent'].includes(form.condition.metric)&&hasCritical?'alerts.timedDurationHelp'"))
  assert.match(en['alerts.timedCriticalHelp'],/CPU and memory thresholds are timed independently/)
  assert.match(en['alerts.timedDurationHelp'],/each require their own uninterrupted confirmation/)
})


test('negative memory warning threshold cannot form a valid critical band',async t=>{
  const form=await page(t)
  form.form.value.condition.value=-1
  await form.save()
  await form.simulate()
  assert.equal(form.calls.length,0)
  assert.equal(form.error.value,en['alerts.criticalRange'])
})


test('invalid memory critical thresholds block save and simulation',async t=>{
  for(const value of [80,79,100.01,'invalid']){
    const form=await page(t)
    form.form.value.condition.critical_value=value
    await form.save()
    await form.simulate()
    assert.equal(form.calls.length,0)
    assert.equal(form.error.value,en['alerts.criticalRange'])
  }
})
