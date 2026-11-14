import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {parse} from '@vue/compiler-sfc'
import {computed,ref,watch,effectScope} from 'vue'
import {alertTargetChoices,filterAlertTargets,emptyTargetFilters} from '../apps/web/src/alert-targets.ts'
import en from '../apps/web/src/locales/en/alerts.ts'
import {actionSummary} from '../apps/web/src/mcp-action-summary.ts'
const source=readFileSync(new URL('../apps/web/src/components/AlertsPage.vue',import.meta.url),'utf8')
async function page(t) {
 const calls=[],scope=effectScope()
 const rule={model_version:2,key:'memory',name:'Memory',target_type:'server',scope_type:'organization',scope_id:'',severity:'warning',condition:{metric:'host.memory_percent',operator:'gt',value:80,critical_value:90},duration_seconds:300,reminder_seconds:900,reminder_intervals:{warning:1800,critical:300},enabled:true,exclusions:[],edit_version:8}
 const inventory={workspaces:[{id:'workspace',login:'Workspace'}],servers:[{id:'server',workspace:'workspace',name:'Jack'}],containers:[],projects:[]}
 const context={computed,ref,watch,onUnmounted:()=>{},defineProps:()=>({route:{action:'edit',key:'memory'},canEdit:true}),useQuasar:()=>({notify:()=>{}}),activeOrganization:ref('org'),t:key=>en[key]||key,locale:ref('en'),leadingRowActions:rows=>rows,alertTargetChoices,filterAlertTargets,emptyTargetFilters,inventoryLabel:row=>row.name||row.login||row.id,window:{location:{hash:''}},pb:{collection:name=>({getFullList:async()=>inventory[name]||[]})},alertsApi:{metrics:async()=>({items:[{id:'host.memory_percent',target_type:'server',operators:['gt'],supports_critical_value:true},{id:'container.state',target_type:'container',operators:['eq'],values:['exited']}]}),rule:async()=>rule,saveRule:async(key,body,version)=>{calls.push({key,body,version});return body},simulate:async body=>({items:[],coverage:{included:1,excluded:1,unknown:1},totalItems:2})}}
 const script=parse(source).descriptor.scriptSetup.content.replace(/^import .*\n/gm,'')
 scope.run(()=>vm.runInNewContext(ts.transpileModule(script+'\nglobalThis.page={form,payload,save,load,exclusionTarget,exclusionReason,addExclusion,changeTarget,targetFilterOptionsForRules,reminderLabel}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context))
 t.after(()=>scope.stop());await context.page.load();return {...context.page,calls}
}
test('type editor sends separate severity cadences and an optimistic version without legacy scope fields',async t=>{
 const p=await page(t);await p.save();const call=p.calls[0]
 assert.equal(call.version,8);assert.equal(call.body.target_type,'server');assert.equal(call.body.reminder_intervals.warning,1800);assert.equal(call.body.reminder_intervals.critical,300)
 assert.equal('scope_id' in call.body,false);assert.equal('scope_type' in call.body,false);assert.equal('edit_version' in call.body,false)
})
test('exclusions capture the resource identity and reason only within the selected condition',async t=>{
 const p=await page(t);p.exclusionTarget.value='server';p.exclusionReason.value='Accepted Windows saturation';p.addExclusion()
 assert.equal(p.form.value.exclusions.length,1);assert.equal(p.payload().exclusions[0].resource_id,'server');assert.equal(p.payload().exclusions[0].reason,'Accepted Windows saturation')
 p.form.value.target_type='container';p.changeTarget();assert.equal(p.form.value.exclusions.length,0);assert.equal(p.form.value.condition.metric,'container.state')
})
test('native rule review exposes type, both reminder intervals and exclusion count',()=>{
 const rows=actionSummary({tool:'save_alert_rule',arguments:{rule:{model_version:2,name:'Memory',target_type:'server',reminder_intervals:{warning:1800,critical:300},exclusions:[{resource_id:'server'}]}}})
 assert.ok(rows.some(row=>row.label==='Target' && row.value==='server'))
 assert.ok(rows.some(row=>row.label==='Reminder warning (seconds)' && row.value==='1800'))
 assert.ok(rows.some(row=>row.label==='Reminder critical (seconds)' && row.value==='300'))
 assert.ok(rows.some(row=>row.label==='Exclusions' && row.value==='1'))
})

test('severity cadence inputs label and validate minutes without the integration seconds label',()=>{
 assert.ok(source.includes("t('alerts.reminderMinutes')+' · '"))
 assert.ok(source.includes("t('alerts.reminderMinutesRange')"))
 assert.ok(!en['alerts.reminderMinutes'].includes('seconds'))
})
