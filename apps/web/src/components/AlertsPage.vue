<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { useQuasar } from 'quasar'
import { pb, activeOrganization } from '../api'
import { alertsApi, inventoryLabel, integrationEndpoint, severityColor, alertLoadError } from '../alerts-api'
import { alertTargetChoices, filterAlertTargets, emptyTargetFilters, type TargetFilters } from '../alert-targets'
import { t, locale } from '../i18n'
import PageHeader from './PageHeader.vue'
import { leadingRowActions } from '../table-columns'
import PageActions from './PageActions.vue'
const props = defineProps<{route: any, canEdit: boolean}>()
const q = useQuasar()
const loading = ref(false), busy = ref(false), error = ref(''), rules = ref<any[]>([]), integrations = ref<any[]>([]), metrics = ref<any[]>([])
const inventory = ref<any>({workspace: [], server: [], container: [], project: []}), preview = ref<any>(null)
const targetSearch = ref(''), targetFilters = ref(emptyTargetFilters())
const integrationDialog = ref(false), integrationEdit = ref(''), secret = ref(''), secretIntegration = ref<any>(null)
const freshRule = () => ({key: '', name: '', enabled: true, severity: 'warning', scope_type: 'workspace', scope_id: '', target_type: 'server', condition: {metric: 'host.cpu_percent', operator: 'gt', value: 90, disk_path: ''}, duration_seconds: 0, reminder_seconds: 900})
const ruleSearch = ref(''), ruleStatus = ref('all'), ruleCondition = ref<string | null>(null), ruleTarget = ref<string | null>(null)
const rulePagination = ref({page:1,rowsPerPage:10})
const conditionFilterOptions = computed(() => [...new Set([...metrics.value.map(row => row.id), ...rules.value.map(rule => rule.condition?.metric)].filter(Boolean))].map(value => {const key='alerts.metric.'+value;return {value,label:t(key)===key?value:t(key)}}).sort((left,right)=>left.label.localeCompare(right.label)))
const targetFilterOptionsForRules = computed(() => {
  const choices=[...new Map(rules.value.map(rule => [rule.scope_type+':'+rule.scope_id,{value:rule.scope_type+':'+rule.scope_id,label:targetLabel(rule)+' · '+t('alerts.scope.'+rule.scope_type)}])).values()]
  return choices.map(row => ({...row,label:choices.some(other => other.value!==row.value && other.label===row.label)?row.label+' · '+row.value.split(':').slice(1).join(':'):row.label})).sort((left,right)=>left.label.localeCompare(right.label))
})
const filteredRules = computed(() => rules.value.filter(rule => (!ruleCondition.value || rule.condition?.metric===ruleCondition.value) && (!ruleTarget.value || rule.scope_type+':'+rule.scope_id===ruleTarget.value) && (ruleStatus.value==='all' || rule.enabled===(ruleStatus.value==='enabled')) && [rule.name,rule.key,rule.condition?.metric,targetLabel(rule)].join(' ').toLowerCase().includes(String(ruleSearch.value || '').toLowerCase())))
const form = ref<any>(freshRule())
const integrationForm = ref<any>({name: '', kind: 'gcp', workspace_id: '', enabled: true, reminder_seconds: 900})
let generation = 0, formGeneration = 0
const tab = computed(() => props.route.section === 'integrations' ? 'integrations' : 'rules')
const editing = computed(() => ['new', 'edit'].includes(props.route.action))
const ruleKey = computed(() => props.route.key || props.route.id || '')
const options = (values: string[], prefix: string) => values.map(value => ({value, label: t(prefix + value)}))
const severities = computed(() => options(['info', 'warning', 'critical'], 'alerts.severity.'))
const scopes = computed(() => options(['workspace', 'server', 'container'], 'alerts.scope.'))
const targets = computed(() => options(form.value.scope_type === 'container' ? ['container'] : ['server', 'container'], 'alerts.scope.'))
const scopeChoices = computed(() => alertTargetChoices(inventory.value, form.value.scope_type))
const filteredScopeChoices = computed(() => filterAlertTargets(scopeChoices.value, targetFilters.value, targetSearch.value))
const selectedTarget = computed(() => scopeChoices.value.find(row => row.value === form.value.scope_id))
const hasTargetFilters = computed(() => Object.values(targetFilters.value).some(Boolean))
const targetHelp = computed(() => t(`alerts.applies.${form.value.scope_type}.${form.value.target_type}`))
const targetFilterFields = computed< (keyof TargetFilters)[] >(() => form.value.scope_type === 'workspace' ? ['provider'] : form.value.scope_type === 'server' ? ['workspace', 'type', 'os'] : ['workspace', 'server', 'project'])
const workspaceChoices = computed(() => inventory.value.workspace.map(row => ({value: row.id, label: inventoryLabel(row)})))
const availableMetrics = computed(() => metrics.value.filter(metric => metric.target_type === form.value.target_type))
const metric = computed(() => metrics.value.find(row => row.id === form.value.condition.metric))
const criticalEligible = computed(() => ['host.cpu_percent','host.memory_percent','host.disk_percent'].includes(form.value.condition.metric) && ['gt','gte'].includes(form.value.condition.operator) && form.value.severity === 'warning')
const criticalSupported = computed(() => metric.value?.supports_critical_value === true)
const hasCritical = computed(() => hasCriticalThreshold(form.value))
const metricOptions = computed(() => availableMetrics.value.map(row => ({value: row.id, label: t('alerts.metric.' + row.id)})))
const operatorOptions = computed(() => (metric.value?.operators || ['gt']).map(value => ({value, label: t('alerts.operator.' + value)})))
const valueOptions = computed(() => (metric.value?.values || []).map(value => ({value, label: t('alerts.value.' + value)})))
const columns = computed(()=>leadingRowActions([
  {name:'name', label:t('alerts.name'), field:'name', align:'left' as const},
  {name:'target', label:t('alerts.target'), field:'scope_id', align:'left' as const},
  {name:'condition', label:t('alerts.condition'), field:'condition', align:'left' as const},
  {name:'severity', label:t('alerts.severity'), field:'severity', align:'left' as const},
  {name:'enabled', label:t('alerts.status'), field:'enabled', align:'left' as const},
  {name:'actions', label:'', field:'key'},
]))
const integrationSearch = ref('')
const filteredIntegrations = computed(() => integrations.value.filter(row => [row.name,row.kind].join(' ').toLowerCase().includes(integrationSearch.value.toLowerCase())))
const ruleActions = computed(() => [...(props.canEdit ? [{label:t('alerts.newRule'),icon:'add',href:'#/alerts/new'}] : []),{label:t('Refresh'),icon:'refresh',loading:loading.value,onClick:()=>load(true)}])
const integrationActions = computed(() => [...(props.canEdit ? [{label:t('alerts.newIntegration'),icon:'add',onClick:()=>openIntegration()}] : []),{label:t('Refresh'),icon:'refresh',loading:loading.value,onClick:()=>load(true)}])
function conditionLabel(rule: any) {
  const valueKey='alerts.value.'+rule.condition.value
  const value=t(valueKey)
  const comparison=t('alerts.operator.'+rule.condition.operator)+' '+(value===valueKey ? rule.condition.value : value)
  if(hasCriticalThreshold(rule))return t('alerts.severity.warning')+': '+comparison+'% · '+t('alerts.severity.critical')+': '+t('alerts.operator.'+rule.condition.operator)+' '+rule.condition.critical_value+'%'+(['host.cpu_percent','host.memory_percent'].includes(rule.condition.metric)&&Number(rule.duration_seconds)>0?' · '+t('alerts.confirmationSummary').replace('{seconds}',String(rule.duration_seconds)):'')
  return comparison
}
function hasCriticalThreshold(rule: any) { return rule.condition?.critical_value !== undefined && rule.condition.critical_value !== null && rule.condition.critical_value !== '' }
function severityLabel(rule: any) { return t(hasCriticalThreshold(rule) ? 'alerts.escalatingSeverity' : 'alerts.severity.'+rule.severity) }
function criticalThreshold(value: any) { return value === undefined || value === null || value === '' || Number.isFinite(Number(value)) && Number.isFinite(Number(form.value.condition.value)) && Number(form.value.condition.value) >= 0 && Number(value) > Number(form.value.condition.value) && Number(value) <= 100 || t('alerts.criticalRange') }
function validateCritical() {
  if(!hasCritical.value)return true
  if(!criticalSupported.value){error.value=t('alerts.criticalUnsupported');return false}
  if(!criticalEligible.value || criticalThreshold(form.value.condition.critical_value)!==true){error.value=t('alerts.criticalRange');return false}
  return true
}
const required = (value: any) => !!String(value ?? '').trim() || t('alerts.required')
const positive = (value: any) => Number.isInteger(Number(value)) && Number(value) >= 60 && Number(value) <= 604800 || t('alerts.reminderRange')
const nonnegative = (value: any) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 604800 || t('alerts.durationRange')
function targetLabel(rule: any) {
  return inventoryLabel(inventory.value[rule.scope_type]?.find(row => row.id === rule.scope_id) || {id: rule.scope_id})
}
function filterTargets(value: string, update: (callback: () => void) => void) { update(() => { targetSearch.value = value }) }
function targetFilterOptions(field: keyof TargetFilters) {
  const filters = emptyTargetFilters()
  if (field !== 'workspace' && field !== 'provider') filters.workspace = targetFilters.value.workspace
  if (field === 'project') filters.server = targetFilters.value.server
  if (field === 'os') filters.type = targetFilters.value.type
  return [...new Set(filterAlertTargets(scopeChoices.value, filters).map(row => row[field]).filter(Boolean))].map(value => ({value, label: ['workspace', 'server', 'project'].includes(field) ? inventoryLabel(inventory.value[field].find(row => row.id === value) || {id: value}) : value})).sort((left, right) => left.label.localeCompare(right.label))
}
function changeTargetFilter(field: keyof TargetFilters) {
  targetFilters.value[field] ||= ''
  if (field === 'workspace') { targetFilters.value.server = ''; targetFilters.value.project = ''; targetFilters.value.type = ''; targetFilters.value.os = '' }
  if (field === 'server') targetFilters.value.project = ''
  if (field === 'type') targetFilters.value.os = ''
  targetSearch.value = ''
  if (form.value.scope_id && !filterAlertTargets(scopeChoices.value, targetFilters.value).some(row => row.value === form.value.scope_id)) form.value.scope_id = ''
}
function changeScope() { form.value.scope_id = ''; targetSearch.value = ''; targetFilters.value = emptyTargetFilters(); if (form.value.scope_type === 'container') form.value.target_type = 'container'; changeTarget() }
function changeTarget() {
  if (!availableMetrics.value.some(row => row.id === form.value.condition.metric)) {
    form.value.condition.metric = availableMetrics.value[0]?.id || ''
    changeMetric()
  }
}
function changeMetric() {
  form.value.condition.operator = metric.value?.operators?.[0] || 'gt'
  form.value.condition.value = metric.value?.values?.[0] ?? (form.value.condition.metric === 'server.no_communication_seconds' ? 900 : 90)
  preview.value = null
}
let contextOrganization = ''
let contextData: any = null
let contextRequest: Promise<any> | null = null
function loadContext(org: string, force: boolean) {
  if(!force && contextOrganization===org && contextData)return Promise.resolve(contextData)
  if(contextOrganization===org && contextRequest)return contextRequest
  contextOrganization=org
  contextData=null
  const request=Promise.all([
    alertsApi.metrics(), pb.collection('workspaces').getFullList(), pb.collection('servers').getFullList(), pb.collection('containers').getFullList(), pb.collection('projects').getFullList(),
  ]).then(result=>{
    if(contextOrganization===org && contextRequest===request)contextData=result
    return result
  }).finally(()=>{if(contextRequest===request)contextRequest=null})
  contextRequest=request
  return request
}
async function load(force = false) {
  const version = ++generation, org = activeOrganization.value
  const action = props.route.action, section = tab.value, key = ruleKey.value
  error.value = ''; secret.value = ''; secretIntegration.value = null; preview.value = null; integrationDialog.value = false
  form.value = freshRule(); targetSearch.value = ''; targetFilters.value = emptyTargetFilters()
  if (!org) {rules.value=[];integrations.value=[];inventory.value={workspace:[],server:[],container:[],project:[]};return}
  loading.value = true
  try {
    const recordRequest = action==='edit' ? alertsApi.rule(key) : action==='new' ? Promise.resolve(null) : section==='integrations' ? alertsApi.integrations() : alertsApi.rules()
    const [context, records] = await Promise.all([loadContext(org,force),recordRequest])
    if (version !== generation || org !== activeOrganization.value) return
    const [catalog, workspaces, servers, containers, projects] = context
    metrics.value = catalog.items
    inventory.value = {workspace: workspaces, server: servers, container: containers, project: projects}
    if(action==='edit')form.value={...freshRule(),...records,condition:{...records.condition}}
    else if(action!=='new') {
      if(section==='integrations')integrations.value=records.items
      else {rules.value=records.items;rulePagination.value.page=1}
    }
  } catch (failure: any) { if (version === generation) error.value = t(alertLoadError(failure, 'alerts.loadError')) }
  finally { if (version === generation) loading.value = false }
}
watch(() => [ruleSearch.value,ruleStatus.value,ruleCondition.value,ruleTarget.value], () => {rulePagination.value.page=1}, {flush:'sync'})
watch([conditionFilterOptions,targetFilterOptionsForRules], () => {
  if(ruleCondition.value && !conditionFilterOptions.value.some(row => row.value===ruleCondition.value))ruleCondition.value=null
  if(ruleTarget.value && !targetFilterOptionsForRules.value.some(row => row.value===ruleTarget.value))ruleTarget.value=null
}, {flush:'sync'})
watch(activeOrganization, () => {ruleCondition.value=null;ruleTarget.value=null;rulePagination.value.page=1}, {flush:'sync'})
watch(form, () => {formGeneration++;preview.value = null}, {deep: true,flush:'sync'})
watch(() => [form.value.condition.metric,form.value.condition.operator,form.value.severity], () => {if(!criticalEligible.value)delete form.value.condition.critical_value}, {flush:'sync'})
watch(() => [activeOrganization.value, props.route.action, props.route.key, props.route.id, props.route.section], () => load(), {immediate: true})
onUnmounted(() => { generation++ })
function payload() { const condition={...form.value.condition,...(form.value.condition.metric === 'host.disk_percent' ? {disk_path: form.value.condition.disk_path?.trim() || '*'} : {})};if(hasCritical.value)condition.critical_value=Number(condition.critical_value);else delete condition.critical_value;return {...form.value, condition, duration_seconds: Number(form.value.duration_seconds), reminder_seconds: Number(form.value.reminder_seconds)} }
async function save() {
  if (!props.canEdit || busy.value || loading.value) return
  if (!validateCritical()) return
  const org = activeOrganization.value, context = generation
  const current = () => org === activeOrganization.value && context === generation && props.canEdit
  busy.value = true; error.value = ''
  try {
    await alertsApi.saveRule(props.route.action === 'edit' ? ruleKey.value : form.value.key, payload())
    if (!current()) return
    q.notify({type: 'positive', message: t('alerts.saved')}); window.location.hash = '#/alerts'
  } catch { if (current()) error.value = t('alerts.saveError') }
  finally { busy.value = false }
}
async function simulate() {
  if(loading.value || busy.value)return
  if(!validateCritical())return
  const version = generation, fields = formGeneration; busy.value = true; error.value = ''
  try { const result = await alertsApi.simulate(payload()); if (version === generation && fields === formGeneration) preview.value = result }
  catch { if (version === generation) error.value = t('alerts.previewError') }
  finally { busy.value = false }
}
function archive(rule: any) {
  if (!props.canEdit || busy.value) return
  const org = activeOrganization.value, context = generation, key = rule.key
  const current = () => org === activeOrganization.value && context === generation && props.canEdit
  q.dialog({title: t('alerts.archive'), message: t('alerts.archiveConfirm'), cancel: true, persistent: true}).onOk(async () => {
    if (!current() || busy.value) return
    busy.value = true
    try { await alertsApi.archiveRule(key); if (current()) await load() }
    catch { if (current()) error.value = t('alerts.saveError') }
    finally { busy.value = false }
  })
}
function openIntegration(row?: any) {
  integrationEdit.value = row?.id || ''; secret.value = ''; secretIntegration.value = null
  integrationForm.value = row ? {...row} : {name: '', kind: 'gcp', workspace_id: '', enabled: true, reminder_seconds: 900}
  integrationDialog.value = true
}
function captureSecret(result: any) {
  secret.value = result.token || ''; secretIntegration.value = result.integration || result
}
async function saveIntegration() {
  if (!props.canEdit || busy.value) return
  const org = activeOrganization.value, context = generation
  const current = () => org === activeOrganization.value && context === generation && props.canEdit
  busy.value = true; error.value = ''
  try {
    const body = {...integrationForm.value, workspace_id: integrationForm.value.workspace_id || '', reminder_seconds: Number(integrationForm.value.reminder_seconds)}
    const result = integrationEdit.value ? await alertsApi.updateIntegration(integrationEdit.value, {name: body.name, enabled: body.enabled, reminder_seconds: body.reminder_seconds}) : await alertsApi.createIntegration(body)
    if (!current()) return
    integrationDialog.value = false
    const list = await alertsApi.integrations()
    if (!current()) return
    integrations.value = list.items; captureSecret(result)
  } catch { if (current()) error.value = t('alerts.integrationError') }
  finally { busy.value = false }
}
function integrationAction(row: any, rotate: boolean) {
  if (!props.canEdit || busy.value) return
  const org = activeOrganization.value, context = generation, id = row.id, selected = {...row}
  const current = () => org === activeOrganization.value && context === generation && props.canEdit
  q.dialog({title: t(rotate ? 'alerts.rotate' : 'alerts.revoke'), message: t(rotate ? 'alerts.rotateConfirm' : 'alerts.revokeConfirm'), cancel: true}).onOk(async () => {
    if (!current() || busy.value) return
    busy.value = true; secret.value = ''
    try {
      const result = rotate ? await alertsApi.rotateIntegration(id) : await alertsApi.revokeIntegration(id)
      if (!current()) return
      const list = await alertsApi.integrations()
      if (!current()) return
      integrations.value = list.items
      if (rotate) captureSecret({...result, integration: result.integration || selected})
    } catch { if (current()) error.value = t('alerts.integrationError') }
    finally { busy.value = false }
  })
}
function previewColor(result: unknown) {
  const value = String(result)
  return value === 'true' ? 'negative' : value === 'false' ? 'positive' : 'grey'
}
async function copySecret() {
  try { await navigator.clipboard.writeText(secret.value); q.notify({message: t('alerts.copied')}) }
  catch { error.value = t('alerts.copyError') }
}
</script>

<template>
  <q-page class="q-pa-md inventory-page alerts-page">
    <PageHeader :title="t(route.action==='new' ? 'alerts.newRule' : editing ? 'alerts.editRule' : 'alerts.title')" :breadcrumbs="editing ? [{label:t('alerts.title'),href:'#/alerts'}] : undefined" />
    <q-banner v-if="error" class="error-banner rounded-borders" role="alert">{{error}}<template #action><q-btn flat no-caps :label="t('alerts.retry')" @click="load(true)"/></template></q-banner>
    <q-card flat bordered class="monitoring-panel">
      <q-tabs v-if="!editing" :model-value="tab" align="left" class="monitoring-tabs" active-color="primary" indicator-color="primary" no-caps><q-route-tab name="rules" :label="t('alerts.rules')" href="#/alerts"/><q-route-tab name="integrations" :label="t('alerts.integrations')" href="#/alerts/integrations"/></q-tabs>
      <q-form v-if="editing && (route.action==='new' || !loading)" @submit="save">
        <section class="monitoring-form-section">
          <div class="row q-col-gutter-md"><q-input v-model="form.name" outlined class="col-12 col-md-8" :label="t('alerts.name')" :rules="[required]" maxlength="160"/><q-select v-model="form.severity" outlined class="col-12 col-md-4" :options="severities" emit-value map-options :label="t('alerts.severity')"/></div>
          <q-input v-model="form.key" outlined class="q-mt-sm" :disable="route.action==='edit'" :label="t('alerts.key')" :hint="t('alerts.keyHelp')" :rules="[required, value => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value) || t('alerts.keyHelp')]" maxlength="80"/>
        </section>
        <section class="monitoring-form-section">
          <h2>{{t('alerts.where')}}</h2>
          <div class="row q-col-gutter-md"><q-select v-model="form.scope_type" outlined class="col-12 col-md-4" :options="scopes" emit-value map-options :label="t('alerts.scope')" @update:model-value="changeScope"/><q-select v-model="form.scope_id" class="col-12 col-md-8" outlined use-input fill-input hide-selected input-debounce="0" :options="filteredScopeChoices" emit-value map-options :display-value="selectedTarget?.label || ''" :label="t('alerts.scope.'+form.scope_type)" :hint="t('alerts.searchTargetHelp')" :rules="[required]" @filter="filterTargets"><template #option="slot"><q-item v-bind="slot.itemProps"><q-item-section><q-item-label>{{slot.opt.label}}</q-item-label><q-item-label v-if="slot.opt.description" caption>{{slot.opt.description}}</q-item-label></q-item-section></q-item></template><template #no-option><q-item><q-item-section>{{t('alerts.noTargets')}}</q-item-section></q-item></template></q-select></div>
          <q-expansion-item dense icon="filter_list" :label="t('alerts.findTarget')" class="target-refinements"><div class="q-pa-md"><div class="row q-col-gutter-sm"><q-select v-for="field in targetFilterFields" :key="field" v-model="targetFilters[field]" outlined dense clearable emit-value map-options class="col-12 col-sm" :options="targetFilterOptions(field)" :label="t('alerts.find.'+field)" @update:model-value="changeTargetFilter(field)"/></div><p class="q-mb-none q-mt-sm">{{t('alerts.findTargetHelp')}}</p><q-btn v-if="hasTargetFilters" flat dense no-caps :label="t('alerts.clearTargetFilters')" @click="targetFilters=emptyTargetFilters();targetSearch=''"/></div></q-expansion-item>
          <div v-if="selectedTarget" class="selected-target"><q-icon name="check_circle" color="positive" size="17px"/><span>{{selectedTarget.label}}<small>{{selectedTarget.description}}</small></span></div>
        </section>
        <section class="monitoring-form-section">
          <h2>{{t('alerts.evaluate')}}</h2>
          <div class="row q-col-gutter-md"><q-select v-if="targets.length>1" v-model="form.target_type" outlined class="col-12 col-md-4" :options="targets" emit-value map-options :label="t('alerts.evaluate')" @update:model-value="changeTarget"/><q-select v-model="form.condition.metric" outlined class="col-12" :class="targets.length>1?'col-md-8':''" :options="metricOptions" emit-value map-options :label="t('alerts.metric')" :rules="[required]" @update:model-value="changeMetric"/></div>
          <p>{{targetHelp}}</p>
          <div class="row q-col-gutter-md"><q-select v-model="form.condition.operator" outlined class="col-12 col-md-6" :options="operatorOptions" emit-value map-options :label="t('alerts.operator')"/><q-select v-if="valueOptions.length" v-model="form.condition.value" outlined class="col-12 col-md-6" :options="valueOptions" emit-value map-options :label="t('alerts.value')"/><q-input v-else v-model.number="form.condition.value" outlined class="col-12 col-md-6" type="number" step="any" :label="t('alerts.value')" :suffix="metric?.unit==='seconds'?t('alerts.unit.seconds'):metric?.unit" :rules="[value => value !== '' && Number.isFinite(Number(value)) || t('alerts.required')]"/></div>
          <q-input v-if="criticalEligible && (criticalSupported || hasCritical)" v-model.number="form.condition.critical_value" outlined clearable class="q-mt-md" type="number" step="any" max="100" suffix="%" :label="t('alerts.criticalThreshold')" :hint="t(['host.cpu_percent','host.memory_percent'].includes(form.condition.metric)&&hasCritical?'alerts.timedCriticalHelp':'alerts.criticalHelp')" :rules="[criticalThreshold]"/>
          <q-banner v-if="hasCritical && !criticalSupported" class="q-mt-md" role="alert">{{t('alerts.criticalUnsupported')}}</q-banner>
          <p v-if="hasCritical">{{conditionLabel(form)}}</p>
          <p v-if="form.condition.metric==='server.no_communication_seconds'">{{t('alerts.communicationHelp')}}</p><q-input v-if="form.condition.metric==='host.disk_percent'" v-model="form.condition.disk_path" outlined class="q-mt-md" :label="t('alerts.diskPath')" :hint="t('alerts.anyDisk')"/>
        </section>
        <section class="monitoring-form-section">
          <div class="row q-col-gutter-md"><q-input v-model.number="form.duration_seconds" outlined class="col-12 col-md-6" type="number" min="0" :label="t('alerts.duration')" :hint="t(['host.cpu_percent','host.memory_percent'].includes(form.condition.metric)&&hasCritical?'alerts.timedDurationHelp':'alerts.durationHelp')" :rules="[nonnegative]"/><q-input v-model.number="form.reminder_seconds" outlined class="col-12 col-md-6" type="number" min="60" max="604800" :label="t('alerts.reminder')" :rules="[positive]"/></div><q-toggle v-model="form.enabled" :label="t('alerts.enabled')"/><p class="q-mb-none q-mt-sm">{{t('alerts.ruleHelp')}}</p>
        </section>
        <div class="monitoring-form-actions"><q-btn flat no-caps :label="t('alerts.cancel')" href="#/alerts"/><q-btn outline no-caps :label="t('alerts.preview')" :loading="busy" :disable="loading" @click="simulate"/><q-btn v-if="canEdit" type="submit" color="primary" unelevated no-caps :label="t(route.action==='new' ? 'alerts.newRule' : 'alerts.save')" :loading="busy" :disable="loading"/></div>
        <section v-if="preview" class="monitoring-form-section preview-panel"><h2>{{t('alerts.previewTitle')}} · {{preview.totalItems}}</h2><p>{{t('alerts.previewHelp')}}</p><p v-if="hasCritical">{{conditionLabel(form)}}</p><q-list separator><q-item v-for="item in preview.items" :key="item.resource_type+item.resource_id"><q-item-section>{{item.resource_name || item.resource_id}}</q-item-section><q-item-section side><q-badge :color="previewColor(item.result)">{{t('alerts.result.'+String(item.result))}}</q-badge><q-badge v-if="item.severity" outline :color="severityColor(item.severity)">{{t('alerts.severity.'+item.severity)}}</q-badge><span class="text-caption">{{item.value ?? '—'}}</span></q-item-section></q-item></q-list></section>
      </q-form>
      <q-card-section v-else-if="editing && loading" class="q-pa-xl text-center"><q-spinner color="primary" size="32px" :aria-label="t('Loading')"/><p>{{t('Loading')}}</p></q-card-section>
      <template v-else-if="!editing && tab==='rules'">
        <div class="monitoring-toolbar rule-list-toolbar"><q-input v-model="ruleSearch" outlined dense clearable :placeholder="t('alerts.search')" :aria-label="t('alerts.search')" class="monitoring-search"><template #prepend><q-icon name="search" size="20px"/></template></q-input><q-select v-model="ruleCondition" outlined dense clearable emit-value map-options :label="t('alerts.condition')" :display-value="ruleCondition ? undefined : t('alerts.allConditions')" :options="conditionFilterOptions" class="monitoring-filter"/><q-select v-model="ruleTarget" outlined dense clearable emit-value map-options :label="t('alerts.target')" :display-value="ruleTarget ? undefined : t('alerts.allTargets')" :options="targetFilterOptionsForRules" class="monitoring-filter"/><q-select v-model="ruleStatus" outlined dense emit-value map-options :label="t('alerts.status')" :options="[{value:'all',label:t('incidents.status.all')},{value:'enabled',label:t('alerts.enabled')},{value:'disabled',label:t('alerts.disabled')}]" class="monitoring-filter"/><div class="monitoring-toolbar-actions"><PageActions :actions="ruleActions"/></div></div>
        <q-table class="inventory-table monitoring-table" flat :grid="q.screen.lt.md" :rows="filteredRules" :columns="columns" row-key="key" :loading="loading" v-model:pagination="rulePagination" :rows-per-page-options="[10,25,50,100]" :no-data-label="rules.length && (ruleSearch || ruleCondition || ruleTarget || ruleStatus!=='all') ? t('No results for this search') : t('alerts.emptyRules')">
          <template #body-cell-actions="slot"><q-td :props="slot"><div class="monitoring-row-actions"><q-btn flat round dense :icon="canEdit?'edit':'visibility'" :aria-label="t(canEdit?'alerts.edit':'alerts.inspect')" :href="`#/alerts/${encodeURIComponent(slot.row.key)}/edit`"><q-tooltip>{{t(canEdit?'alerts.edit':'alerts.inspect')}}</q-tooltip></q-btn><q-btn v-if="canEdit" flat round dense color="negative" icon="archive" :aria-label="t('alerts.archive')" @click="archive(slot.row)"><q-tooltip>{{t('alerts.archive')}}</q-tooltip></q-btn></div></q-td></template>
          <template #body-cell-name="slot"><q-td :props="slot"><a class="monitoring-primary" :href="`#/alerts/${encodeURIComponent(slot.row.key)}/edit`">{{slot.row.name}}</a><div class="monitoring-secondary rule-key" :title="slot.row.key">{{slot.row.key}}</div></q-td></template>
          <template #body-cell-target="slot"><q-td :props="slot"><div>{{targetLabel(slot.row)}}</div><div class="monitoring-secondary">{{t('alerts.scope.'+slot.row.scope_type)}}<template v-if="slot.row.scope_type!==slot.row.target_type"> · {{t('alerts.scope.'+slot.row.target_type)}}</template></div></q-td></template>
          <template #body-cell-condition="slot"><q-td :props="slot"><div>{{t('alerts.metric.'+slot.row.condition.metric)}}</div><div class="monitoring-secondary">{{conditionLabel(slot.row)}}</div></q-td></template>
          <template #body-cell-severity="slot"><q-td :props="slot"><span class="monitoring-status" :class="'severity-'+slot.row.severity">{{severityLabel(slot.row)}}</span></q-td></template>
          <template #body-cell-enabled="slot"><q-td :props="slot"><span class="monitoring-status" :class="slot.row.enabled?'status-enabled':'status-disabled'"><q-icon :name="slot.row.enabled?'check_circle':'pause_circle'" size="14px"/>{{t(slot.row.enabled?'alerts.enabled':'alerts.disabled')}}</span></q-td></template>
          <template #item="slot"><q-card flat bordered class="monitoring-mobile-card"><q-card-section><div class="row items-start no-wrap q-gutter-sm"><div class="col"><a class="monitoring-primary" :href="`#/alerts/${encodeURIComponent(slot.row.key)}/edit`">{{slot.row.name}}</a><div class="monitoring-secondary">{{slot.row.key}}</div></div><q-btn flat round dense icon="more_horiz" :aria-label="t('alerts.actions')"><q-menu><q-list><q-item clickable v-close-popup :href="`#/alerts/${encodeURIComponent(slot.row.key)}/edit`"><q-item-section>{{t(canEdit?'alerts.edit':'alerts.inspect')}}</q-item-section></q-item><q-item v-if="canEdit" clickable v-close-popup @click="archive(slot.row)"><q-item-section class="text-negative">{{t('alerts.archive')}}</q-item-section></q-item></q-list></q-menu></q-btn></div><div class="row items-center q-gutter-sm q-mt-sm"><span class="monitoring-status" :class="'severity-'+slot.row.severity">{{severityLabel(slot.row)}}</span><span class="monitoring-status" :class="slot.row.enabled?'status-enabled':'status-disabled'">{{t(slot.row.enabled?'alerts.enabled':'alerts.disabled')}}</span></div><div class="monitoring-mobile-details"><div><small>{{t('alerts.target')}}</small>{{targetLabel(slot.row)}}</div><div><small>{{t('alerts.condition')}}</small>{{t('alerts.metric.'+slot.row.condition.metric)}}<div class="monitoring-secondary">{{conditionLabel(slot.row)}}</div></div></div></q-card-section></q-card></template>
        </q-table>
      </template>
      <template v-else-if="!editing">
        <div class="monitoring-toolbar"><q-input v-model="integrationSearch" outlined dense clearable :placeholder="t('Search')" :aria-label="t('Search')" class="monitoring-search"><template #prepend><q-icon name="search" size="20px"/></template></q-input><div class="monitoring-toolbar-actions"><PageActions :actions="integrationActions"/></div></div>
        <q-banner v-if="secret" class="integration-secret"><strong>{{t('alerts.secretOnce')}}</strong><q-input :key="q.screen.width" :model-value="secret" outlined readonly type="textarea" autogrow class="q-mt-md" :label="t('alerts.secret')"/><div class="row q-gutter-sm q-mt-sm"><q-btn flat no-caps icon="content_copy" :label="t('alerts.copy')" @click="copySecret"/><q-btn flat no-caps :label="t('alerts.dismiss')" @click="secret='';secretIntegration=null"/></div><p v-if="secretIntegration?.id" class="q-mb-none">{{t('alerts.username')}}: {{secretIntegration.id}}</p></q-banner>
        <section v-for="row in filteredIntegrations" :key="row.id" class="integration-record"><div class="integration-record-heading"><div v-if="canEdit && !q.screen.lt.md" class="monitoring-row-actions"><q-btn flat round dense icon="edit" :aria-label="t('alerts.edit')" @click="openIntegration(row)"><q-tooltip>{{t('alerts.edit')}}</q-tooltip></q-btn><q-btn flat round dense icon="vpn_key" :aria-label="t('alerts.rotate')" :disable="!row.enabled" @click="integrationAction(row,true)"><q-tooltip>{{t('alerts.rotate')}}</q-tooltip></q-btn><q-btn flat round dense color="negative" icon="block" :aria-label="t('alerts.revoke')" @click="integrationAction(row,false)"><q-tooltip>{{t('alerts.revoke')}}</q-tooltip></q-btn></div><div class="integration-identity"><h2>{{row.name}}</h2><div class="monitoring-secondary">{{row.kind==='gcp'?t('alerts.gcp'):t('alerts.generic')}}</div></div><span class="monitoring-status" :class="row.enabled?'status-enabled':'status-disabled'">{{t(row.enabled?'alerts.enabled':'alerts.disabled')}}</span><q-btn v-if="canEdit && q.screen.lt.md" flat round dense icon="more_horiz" :aria-label="t('alerts.actions')"><q-menu><q-list><q-item clickable v-close-popup @click="openIntegration(row)"><q-item-section>{{t('alerts.edit')}}</q-item-section></q-item><q-item clickable v-close-popup :disable="!row.enabled" @click="integrationAction(row,true)"><q-item-section>{{t('alerts.rotate')}}</q-item-section></q-item><q-item clickable v-close-popup @click="integrationAction(row,false)"><q-item-section class="text-negative">{{t('alerts.revoke')}}</q-item-section></q-item></q-list></q-menu></q-btn></div><q-expansion-item dense :label="t('incidents.details')" class="integration-details"><div class="q-pa-md"><p class="monitoring-secondary">{{t(row.kind==='gcp'?'alerts.gcpInstructions':'alerts.genericInstructions')}}</p><q-input outlined readonly dense autogrow type="textarea" :model-value="integrationEndpoint(row)" :label="t('alerts.target')"/><div class="monitoring-secondary q-mt-sm">{{t('alerts.username')}}: {{row.id}}</div><div class="monitoring-secondary">{{t('alerts.reminder')}}: {{row.reminder_seconds}}</div><q-expansion-item dense :label="t('alerts.lastReceipt')" class="q-mt-md"><div v-if="row.last_received_at" class="q-pa-md"><div class="monitoring-secondary">{{new Date(row.last_received_at.replace(' ','T')).toLocaleString(locale)}}</div><pre class="evidence">{{JSON.stringify(row.last_event || {}, null, 2)}}</pre></div><p v-else class="monitoring-secondary q-pa-md">{{t('alerts.noReceipt')}}</p></q-expansion-item></div></q-expansion-item></section>
        <div v-if="!filteredIntegrations.length && !loading" class="empty-state"><q-icon name="notifications_none" size="32px"/><p>{{t(integrationSearch?'No results for this search':'alerts.emptyIntegrations')}}</p></div>
      </template>
    </q-card>
    <q-dialog v-model="integrationDialog"><q-card class="integration-dialog"><q-form @submit="saveIntegration"><q-card-section><h2 class="text-h6 q-ma-none">{{t(integrationEdit?'alerts.editIntegration':'alerts.newIntegration')}}</h2></q-card-section><q-card-section class="q-gutter-y-md"><q-input v-model="integrationForm.name" outlined :label="t('alerts.name')" :rules="[required]"/><div class="row q-col-gutter-md"><q-select v-model="integrationForm.kind" :disable="!!integrationEdit" outlined emit-value map-options class="col-12 col-sm-6" :label="t('alerts.integrationKind')" :options="[{value:'gcp',label:t('alerts.gcp')},{value:'generic',label:t('alerts.generic')}]"/><q-select v-model="integrationForm.workspace_id" :disable="!!integrationEdit" outlined clearable emit-value map-options class="col-12 col-sm-6" :options="workspaceChoices" :label="t('alerts.optionalWorkspace')"/></div><q-input v-model.number="integrationForm.reminder_seconds" outlined type="number" min="60" max="604800" :label="t('alerts.reminder')" :rules="[positive]"/><q-toggle v-model="integrationForm.enabled" :label="t('alerts.enabled')"/></q-card-section><q-card-actions align="right" class="q-pa-md"><q-btn flat no-caps :label="t('alerts.cancel')" v-close-popup/><q-btn color="primary" unelevated no-caps type="submit" :label="t('alerts.save')" :loading="busy"/></q-card-actions></q-form></q-card></q-dialog>
  </q-page>
</template>
<style scoped>
.rule-list-toolbar .monitoring-filter{flex:1 1 190px;min-width:0;max-width:100%}.rule-list-toolbar .monitoring-search{flex:2 1 280px}.rule-list-toolbar .monitoring-toolbar-actions{flex-shrink:0}
@media(max-width:700px){.rule-list-toolbar .monitoring-filter{flex:1 1 200px}.rule-list-toolbar .monitoring-search{flex-basis:100%}}
.rule-key{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.target-refinements{margin-top:12px;border:1px solid rgba(127,127,127,.16);border-radius:8px}.selected-target{display:flex;align-items:flex-start;gap:8px;margin-top:16px;font-size:13px}.selected-target small{display:block;color:var(--i7y-muted,#71717a);font-size:12px;line-height:20px}.selected-target .q-icon{margin-top:2px}.preview-panel{background:rgba(127,127,127,.035)}.severity-critical{color:var(--q-negative);background:rgba(239,68,68,.09)}.severity-warning{color:#a16207;background:rgba(234,179,8,.12)}.severity-info{color:var(--q-primary);background:rgba(79,70,229,.08)}.status-enabled{color:#15803d;background:rgba(34,197,94,.09)}.status-disabled{color:var(--i7y-muted,#71717a)}.integration-record{padding:20px 24px;border-bottom:1px solid rgba(127,127,127,.16)}.integration-record:last-child{border-bottom:0}.integration-record-heading{display:flex;align-items:center;gap:16px;min-width:0}.integration-identity{flex:1;min-width:0}.integration-identity h2{font-size:14px;font-weight:500;line-height:21px;margin:0;overflow-wrap:anywhere}.integration-details{margin:16px 0 0 120px;border:1px solid rgba(127,127,127,.16);border-radius:8px}.integration-secret{padding:24px;background:rgba(79,70,229,.06);border-bottom:1px solid rgba(127,127,127,.16)}.integration-dialog{width:640px;max-width:calc(100vw - 32px)}.evidence{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.7;max-height:280px;overflow:auto}.empty-state p{font-size:14px;line-height:22px;color:var(--i7y-muted,#71717a)}
:global(.body--dark) .status-enabled{color:#86efac}:global(.body--dark) .severity-warning{color:#fde047}:global(.body--dark) .severity-info{color:#a5b4fc}:global(.body--dark) .selected-target small{color:#a1a1aa}
@media(max-width:1023px){.integration-details{margin-left:0}.integration-record{padding:16px}.integration-record-heading{flex-wrap:wrap;gap:10px}.integration-identity{flex:1 1 calc(100% - 50px)}.integration-record-heading>.monitoring-status{order:3}.integration-secret{padding:16px}}
</style>
