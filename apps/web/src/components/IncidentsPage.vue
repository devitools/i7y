<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { activeOrganization, authStore } from '../api'
import { alertsApi, incidentPhase, severityColor, alertTimestamp, alertLoadError } from '../alerts-api'
import { t, locale } from '../i18n'
import { incidentTargetHref, incidentMetric } from '../incident-presentation'
import PageHeader from './PageHeader.vue'
import PageActions from './PageActions.vue'
const props = defineProps<{route:any, canEdit:boolean}>()
const q = useQuasar()
const rows = ref<any[]>([]), incident = ref<any>(null), loading = ref(false), busy = ref(false), error = ref('')
const total = ref(0), claimDialog = ref(false), claimMinutes = ref(30), clock = ref(Date.now())
const pagination = ref({page:1,rowsPerPage:10,rowsNumber:0})
const sourceRules = ref<any[]>([]), sourceRulesLoading = ref(false)
const sourceRule = computed(() => sourceRules.value.find(rule => rule.id === incident.value?.rule))
const showFilters = ref(false)
const filters = ref({status:'open', severity:'', origin:'', resource_type:'', resource_id:'', assignee:'', overdue:false, search:''})
let sourceRulesContext = -1
let generation = 0, contextGeneration = 0, timer: ReturnType<typeof setInterval>
const detailId = computed(() => props.route.id || '')
const phase = computed(() => incident.value ? incidentPhase(incident.value, clock.value) : '')
const disabledRule = computed(() => {
  const events = (incident.value?.events || []).filter(event => ['rule_disabled','rule_enabled'].includes(event.kind))
  return events.at(-1)?.kind === 'rule_disabled'
})
const owner = computed(() => incident.value?.assignee === authStore.record?.id)
const activeClaim = computed(() => incident.value?.assignee && alertTimestamp(incident.value.claim_until) > clock.value)
const canClaim = computed(() => props.canEdit && incident.value?.status === 'open' && (!activeClaim.value || owner.value))
const options = (values: string[], prefix: string) => values.map(value => ({value, label:t(prefix+value)}))
const statusOptions = computed(() => options(['open','resolved','all'],'incidents.status.'))
const severityOptions = computed(() => [{value:'',label:t('incidents.allSeverities')},...options(['info','warning','critical'],'alerts.severity.')])
const originOptions = computed(() => [{value:'',label:t('incidents.allOrigins')},...options(['rule','api','gcp'],'incidents.origin.')])
const resourceOptions = computed(() => [{value:'',label:t('incidents.allResources')},...options(['server','container'],'alerts.scope.')])
const columns = computed(() => [
  {name:'title',label:t('incidents.title'),field:'title',align:'left' as const},
  {name:'metric',label:t('incidents.latestValue'),field:'evidence',align:'left' as const},
  {name:'severity',label:t('alerts.severity'),field:'severity',align:'left' as const},
  {name:'state',label:t('alerts.status'),field:'status',align:'left' as const},
  {name:'assignee',label:t('incidents.assignee'),field:'assignee',align:'left' as const},
  {name:'opened',label:t('incidents.opened'),field:'opened_at',align:'left' as const},
])
const formatDate = (value: string) => value ? new Date(value.replace(' ','T')).toLocaleString(locale.value) : '—'
const pretty = (value: any) => JSON.stringify(value, null, 2)
const metricValue = (row: any) => incidentMetric(row,t,locale.value)
const resourceLabel = (row: any) => row.resource_name || t('incidents.externalTarget')
const assigneeLabel = (row: any) => !row.assignee ? t('incidents.unassigned') : row.assignee === authStore.record?.id ? authStore.record?.name || authStore.record?.email || t('incidents.assigned') : t('incidents.assigned')
const phaseTone = (row: any) => ({resolved:'positive',overdue:'negative',open:'primary',inProgress:'primary'})[incidentPhase(row,clock.value)] || 'grey-7'
const formatDay = (value: string) => value ? new Date(value.replace(' ','T')).toLocaleDateString(locale.value) : '—'
const formatTime = (value: string) => value ? new Date(value.replace(' ','T')).toLocaleTimeString(locale.value,{hour:'2-digit',minute:'2-digit'}) : ''
const detailActions = computed(() => [
  ...(incident.value?.origin==='rule' && incident.value?.rule ? [{label:t('incidents.viewAlert'),icon:'notifications_active',outline:true,href:sourceRule.value?'#/alerts/'+encodeURIComponent(sourceRule.value.key)+'/edit':undefined,loading:sourceRulesLoading.value,disable:!sourceRulesLoading.value && !sourceRule.value}] : []),
  ...(props.canEdit && incident.value?.status==='open' ? [
  ...(canClaim.value ? [{label:t(owner.value && activeClaim.value?'incidents.extend':'incidents.claim'),icon:'person',disable:busy.value,onClick:()=>claimDialog.value=true}] : []),
  {label:t('incidents.resolve'),outline:true,loading:busy.value,onClick:resolve},
] : []),
])

async function loadSourceRules() {
  const context = contextGeneration, org = activeOrganization.value
  sourceRules.value = []
  if (!org || !detailId.value) return
  sourceRulesLoading.value = true
  try {
    const result = await alertsApi.rules()
    if (context === contextGeneration && org === activeOrganization.value) sourceRules.value = result.items
  } catch {
    if (context === contextGeneration) error.value = t('incidents.sourceAlertError')
  } finally {
    if (context === contextGeneration) sourceRulesLoading.value = false
  }
}
function openIncident(row: any) { window.location.hash = '#/incidents/' + encodeURIComponent(row.id) }
function requestPage({pagination: next}: any) {
  pagination.value = {...next,rowsNumber:total.value}
  load()
}
function query() {
  return Object.fromEntries(Object.entries({...filters.value, page:pagination.value.page, perPage:pagination.value.rowsPerPage}).filter(([,value]) => value !== '' && value !== false))
}
async function load(background = false) {
  const request = ++generation, org = activeOrganization.value, id = detailId.value
  if (!org) {rows.value = []; incident.value = null; return}
  if (!background) {loading.value = true; error.value = ''}
  try {
    const result = id ? await alertsApi.incident(id) : await alertsApi.incidents(query())
    if (request !== generation || org !== activeOrganization.value || id !== detailId.value) return
    if (id) {
      incident.value = result
      if (result.origin==='rule' && result.rule && sourceRulesContext!==contextGeneration) {sourceRulesContext=contextGeneration;void loadSourceRules()}
    }
    else { rows.value = result.items; total.value = result.totalItems; pagination.value.rowsNumber = result.totalItems }
    error.value = ''
  } catch (failure: any) { if (request === generation) error.value = t(alertLoadError(failure, 'incidents.loadError')) }
  finally { if (request === generation) loading.value = false }
}
watch(() => [activeOrganization.value, detailId.value], () => {contextGeneration++;sourceRules.value=[];sourceRulesLoading.value=false;sourceRulesContext=-1;rows.value=[];incident.value=null;claimDialog.value=false;pagination.value.page=1;load()}, {immediate:true})
function applyFilters() { pagination.value.page = 1; load() }
function resetFilters() { filters.value = {status:'open',severity:'',origin:'',resource_type:'',resource_id:'',assignee:'',overdue:false,search:''};applyFilters() }
async function claim() {
  if (!canClaim.value || busy.value || !Number.isFinite(Number(claimMinutes.value)) || Number(claimMinutes.value) <= 0 || Number(claimMinutes.value) > 10080) return
  const org = activeOrganization.value, id = detailId.value, context = contextGeneration
  const current = () => org === activeOrganization.value && id === detailId.value && context === contextGeneration && props.canEdit
  busy.value = true;error.value = ''
  try {
    await alertsApi.claim(id,new Date(Date.now()+Number(claimMinutes.value)*60000).toISOString(),incident.value.version)
    if (!current()) return
    claimDialog.value=false;await load();q.notify({message:t('incidents.claimed'),type:'positive'})
  } catch (failure: any) { if (current()) {if(failure.status===409)await load(true);error.value = t(failure.status===409?'incidents.conflict':'incidents.claimError')} }
  finally {busy.value = false}
}
function resolve() {
  if (!props.canEdit || incident.value?.status !== 'open' || busy.value) return
  const org = activeOrganization.value, id = detailId.value, version = incident.value.version, context = contextGeneration
  const current = () => org === activeOrganization.value && id === detailId.value && context === contextGeneration && props.canEdit
  q.dialog({title:t('incidents.resolve'),message:t(incident.value.origin==='rule'?'incidents.resolveRuleConfirm':'incidents.resolveExternalConfirm'),cancel:true,persistent:true}).onOk(async () => {
    if (!current() || busy.value) return
    busy.value=true;error.value=''
    try {await alertsApi.resolve(id,version);if(current())await load()}
    catch (failure:any) {if(current())error.value=t(failure.status===409?'incidents.conflict':'incidents.resolveError')}
    finally {busy.value=false}
  })
}
onMounted(() => {timer=setInterval(() => {clock.value=Date.now();if(!busy.value && !claimDialog.value)load(true)},10000)})
onUnmounted(() => {generation++;contextGeneration++;clearInterval(timer)})
</script>
<template>
  <q-page class="q-pa-md inventory-page issues-page">
    <PageHeader :title="detailId && incident ? incident.title : t('incidents.title')" :breadcrumbs="detailId && incident ? [{label:t('incidents.title'),href:'#/incidents'}] : undefined" />
    <q-banner v-if="error" class="error-banner" role="alert">{{error}}</q-banner>
    <q-card v-if="detailId && !incident && loading" flat bordered><q-card-section class="q-pa-xl text-center"><q-spinner color="primary" size="32px" :aria-label="t('Loading')"/><p>{{t('Loading')}}</p></q-card-section></q-card>
    <template v-if="detailId && incident">
      <q-banner v-if="disabledRule && incident.status==='open'" class="incident-notice q-mb-md">{{t('incidents.ruleDisabled')}}</q-banner>
      <q-card flat bordered class="monitoring-panel incident-summary">
        <div class="incident-summary-heading">
          <div class="incident-summary-context"><div class="incident-badges"><q-badge outline :color="severityColor(incident.severity)">{{t('alerts.severity.'+incident.severity)}}</q-badge><q-badge outline :color="phaseTone(incident)">{{t('incidents.phase.'+phase)}}</q-badge></div><a v-if="incidentTargetHref(incident)" class="incident-resource incident-target" :href="incidentTargetHref(incident)">{{resourceLabel(incident)}}</a><strong v-else class="incident-resource">{{resourceLabel(incident)}}</strong><span class="monitoring-secondary">{{t('incidents.origin.'+incident.origin)}}</span></div>
          <PageActions :actions="detailActions" />
        </div>
        <dl class="incident-facts">
          <div><dt>{{t('incidents.opened')}}</dt><dd><time :datetime="incident.opened_at">{{formatDate(incident.opened_at)}}</time></dd></div>
          <div><dt>{{t('incidents.assignee')}}</dt><dd>{{assigneeLabel(incident)}}</dd></div>
          <div><dt>{{t('incidents.deadline')}}</dt><dd :class="{'incident-overdue':phase==='overdue'}">{{formatDate(incident.claim_until)}}</dd></div>
          <div><dt>{{t(incident.status==='resolved'?'incidents.resolved':'incidents.nextReminder')}}</dt><dd>{{formatDate(incident.status==='resolved'?incident.resolved_at:incident.next_reminder_at)}}</dd></div>
        </dl>
        <p v-if="incident.status==='resolved'" class="incident-resolution">{{t('incidents.reason')}}: {{t('incidents.reason.'+incident.resolution_reason)}}</p>
      </q-card>
      <div class="incident-detail-layout">
        <q-card flat bordered class="monitoring-panel incident-history"><q-card-section class="incident-section-heading"><h2>{{t('incidents.timeline')}}</h2></q-card-section>
          <ol v-if="incident.events?.length" class="incident-events"><li v-for="event in incident.events" :key="event.id"><div class="incident-event-heading"><strong>{{t('incidents.event.'+event.kind)}}</strong><time :datetime="event.occurred_at">{{formatDate(event.occurred_at)}}</time></div><p v-if="event.actor && event.actor===authStore.record?.id" class="monitoring-secondary">{{authStore.record?.name || authStore.record?.email}}</p><q-expansion-item v-if="event.actor || event.data && Object.keys(event.data).length" dense :label="t('incidents.details')" class="incident-event-details"><div class="incident-technical-content"><p v-if="event.actor"><span>{{t('incidents.actor')}}</span><code>{{event.actor}}</code></p><pre v-if="event.data && Object.keys(event.data).length" class="incident-json">{{pretty(event.data)}}</pre></div></q-expansion-item></li></ol><p v-else class="incident-empty">{{t('incidents.noHistory')}}</p>
        </q-card>
        <div class="incident-supporting"><q-card flat bordered class="monitoring-panel"><q-expansion-item :label="t('incidents.evidence')" class="incident-evidence"><pre class="incident-json incident-evidence-content">{{pretty(incident.evidence || {})}}</pre></q-expansion-item></q-card><q-card flat bordered class="monitoring-panel"><q-expansion-item :label="t('incidents.technicalDetails')"><dl class="incident-technical-content"><div><dt>{{t('incidents.resourceType')}}</dt><dd>{{incident.resource_type?t('alerts.scope.'+incident.resource_type):t('incidents.externalTarget')}}</dd></div><div v-if="incident.resource_id"><dt>{{t('incidents.resourceId')}}</dt><dd><code>{{incident.resource_id}}</code></dd></div><div v-if="incident.assignee"><dt>{{t('incidents.assigneeId')}}</dt><dd><code>{{incident.assignee}}</code></dd></div><div v-if="incident.rule_revision"><dt>{{t('incidents.revision')}}</dt><dd>{{incident.rule_revision}}</dd></div></dl></q-expansion-item></q-card></div>
      </div>
    </template>
    <q-card v-else-if="!detailId" flat bordered class="monitoring-panel issue-list-card">
      <q-form @submit="applyFilters">
        <div class="monitoring-toolbar incident-toolbar">
          <q-input v-model="filters.search" outlined dense clearable :placeholder="t('incidents.search')" :aria-label="t('incidents.search')" class="monitoring-search" @clear="applyFilters"><template #prepend><q-icon name="search" size="20px"/></template></q-input>
          <q-select v-model="filters.status" outlined dense emit-value map-options :options="statusOptions" :label="t('alerts.status')" class="monitoring-filter" @update:model-value="applyFilters"/>
          <q-btn type="submit" flat no-caps :label="t('incidents.searchAction')" class="incident-search-submit"/>
          <q-btn v-if="q.screen.lt.md" outline no-caps icon="tune" :label="q.screen.lt.sm?undefined:t('incidents.filters')" :color="showFilters?'primary':undefined" :aria-label="t('incidents.filters')" :aria-expanded="showFilters" aria-controls="incident-filter-panel" @click="showFilters=!showFilters"/>
          <div class="monitoring-toolbar-actions"><PageActions :actions="[{label:t('Refresh'),icon:'refresh',loading,onClick:()=>load()}]" /></div>
        </div>
        <div v-show="!q.screen.lt.md || showFilters" id="incident-filter-panel" class="incident-filter-panel">
          <div class="incident-filter-grid"><q-select v-model="filters.severity" outlined dense :options="severityOptions" emit-value map-options :label="t('alerts.severity')"/><q-select v-model="filters.origin" outlined dense :options="originOptions" emit-value map-options :label="t('incidents.origin')"/><q-select v-model="filters.resource_type" outlined dense :options="resourceOptions" emit-value map-options :label="t('incidents.resourceType')"/><q-input v-model="filters.resource_id" outlined dense :label="t('incidents.resourceId')"/><q-input v-model="filters.assignee" outlined dense :label="t('incidents.assigneeId')"/></div>
          <div class="incident-filter-footer"><q-checkbox v-model="filters.overdue" dense :label="t('incidents.overdueOnly')"/><div class="incident-filter-actions"><q-btn flat no-caps :label="t('incidents.reset')" @click="resetFilters"/><q-btn type="submit" color="primary" unelevated no-caps :label="t('incidents.filter')"/></div></div>
        </div>
      </q-form>
      <q-table class="inventory-table monitoring-table incidents-table" flat :grid="q.screen.lt.md" :rows="rows" :columns="columns" row-key="id" :loading="loading" v-model:pagination="pagination" :rows-per-page-options="[10,25,50]" @request="requestPage" @row-click="(_, row) => openIncident(row)" :no-data-label="t('incidents.empty')">
        <template #body-cell-title="slot"><q-td :props="slot" class="incident-primary-cell"><div class="incident-identity"><span class="row-icon"><q-icon name="report_problem" size="19px"/></span><div class="incident-identity-text"><button class="name-cell incident-name" :title="slot.row.title" @click.stop="openIncident(slot.row)"><strong>{{slot.row.title}}</strong></button><div class="monitoring-secondary incident-resource-line"><a v-if="incidentTargetHref(slot.row)" class="incident-target" :href="incidentTargetHref(slot.row)" @click.stop>{{resourceLabel(slot.row)}}</a><span v-else>{{resourceLabel(slot.row)}}</span></div></div></div></q-td></template>
        <template #body-cell-metric="slot"><q-td :props="slot"><strong>{{metricValue(slot.row)}}</strong><div v-if="slot.row.evidence?.observed_at" class="monitoring-secondary">{{formatDate(slot.row.evidence.observed_at)}}</div></q-td></template>
        <template #body-cell-severity="slot"><q-td :props="slot"><q-badge outline :color="severityColor(slot.row.severity)">{{t('alerts.severity.'+slot.row.severity)}}</q-badge></q-td></template>
        <template #body-cell-state="slot"><q-td :props="slot"><q-badge outline :color="phaseTone(slot.row)">{{t('incidents.phase.'+incidentPhase(slot.row,clock))}}</q-badge><div class="monitoring-secondary">{{t('incidents.origin.'+slot.row.origin)}}</div></q-td></template>
        <template #body-cell-assignee="slot"><q-td :props="slot"><span>{{assigneeLabel(slot.row)}}</span><div v-if="slot.row.claim_until && slot.row.assignee" class="monitoring-secondary" :class="{'incident-overdue':incidentPhase(slot.row,clock)==='overdue'}">{{formatDate(slot.row.claim_until)}}</div></q-td></template>
        <template #body-cell-opened="slot"><q-td :props="slot"><time class="incident-list-time" :datetime="slot.row.opened_at"><span>{{formatDay(slot.row.opened_at)}}</span><small>{{formatTime(slot.row.opened_at)}}</small></time></q-td></template>
        <template #item="slot"><q-card flat bordered class="incident-mobile-card"><q-card-section><div class="incident-mobile-badges"><q-badge outline :color="severityColor(slot.row.severity)">{{t('alerts.severity.'+slot.row.severity)}}</q-badge><q-badge outline :color="phaseTone(slot.row)">{{t('incidents.phase.'+incidentPhase(slot.row,clock))}}</q-badge></div><div class="incident-identity"><span class="row-icon"><q-icon name="report_problem" size="19px"/></span><div class="incident-identity-text"><button class="name-cell incident-name" :title="slot.row.title" @click.stop="openIncident(slot.row)"><strong>{{slot.row.title}}</strong></button><p class="monitoring-secondary incident-mobile-resource"><a v-if="incidentTargetHref(slot.row)" class="incident-target" :href="incidentTargetHref(slot.row)" @click.stop>{{resourceLabel(slot.row)}}</a><span v-else>{{resourceLabel(slot.row)}}</span></p></div></div><dl class="incident-mobile-facts"><div><dt>{{t('incidents.latestValue')}}</dt><dd>{{metricValue(slot.row)}}<div v-if="slot.row.evidence?.observed_at" class="monitoring-secondary">{{formatDate(slot.row.evidence.observed_at)}}</div></dd></div><div><dt>{{t('incidents.assignee')}}</dt><dd>{{assigneeLabel(slot.row)}}</dd></div><div><dt>{{t('incidents.opened')}}</dt><dd>{{formatDate(slot.row.opened_at)}}</dd></div><div v-if="slot.row.claim_until && slot.row.assignee"><dt>{{t('incidents.deadline')}}</dt><dd :class="{'incident-overdue':incidentPhase(slot.row,clock)==='overdue'}">{{formatDate(slot.row.claim_until)}}</dd></div></dl></q-card-section></q-card></template>
      </q-table>
    </q-card>
    <q-dialog v-model="claimDialog"><q-card class="incident-claim-dialog"><q-form @submit="claim"><div class="monitoring-form-section"><h2>{{t(owner && activeClaim?'incidents.extend':'incidents.claim')}}</h2><p>{{t('incidents.claimHelp')}}</p><q-input v-model.number="claimMinutes" outlined autofocus type="number" min="1" max="10080" :label="t('incidents.timeNeeded')" :rules="[value => Number(value)>0 && Number(value)<=10080 || t('incidents.timeRange')]"/><p class="monitoring-secondary">{{t('incidents.claimLimit')}}</p></div><div class="monitoring-form-actions"><q-btn flat no-caps :label="t('alerts.cancel')" v-close-popup :disable="busy"/><q-btn color="primary" unelevated no-caps type="submit" :label="t('incidents.confirmClaim')" :loading="busy" :disable="!canClaim"/></div></q-form></q-card></q-dialog>
  </q-page>
</template>
<style scoped>
.incident-summary-heading :deep(.q-btn--outline){color:var(--i7y-navigation-active-text)!important}

.incident-name{max-width:100%;color:var(--i7y-text)}.incident-name strong{max-width:440px}.incidents-table :deep(tbody tr){cursor:pointer}

.incident-identity{display:flex;align-items:center;gap:12px}.incident-identity-text{min-width:0}.incident-target{color:inherit;text-decoration:none}.incident-target:hover,.incident-target:focus-visible{color:var(--i7y-navigation-active-text);text-decoration:underline;text-underline-offset:2px}

.incident-toolbar .monitoring-filter{flex:none}.incident-filter-panel{padding:16px;border-bottom:1px solid rgba(127,127,127,.18);background:rgba(127,127,127,.025)}.incident-filter-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.incident-filter-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:16px}.incident-filter-actions{display:flex;gap:8px;flex-wrap:wrap}.incident-link{display:block;text-decoration:none;overflow-wrap:anywhere}.incident-link:hover{text-decoration:underline}.incident-primary-cell{width:38%;min-width:220px}.incident-primary-cell .incident-link,.incident-resource-line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.incident-resource-line{margin-top:4px}.incident-list-time{display:flex;flex-direction:column;gap:4px;white-space:nowrap}.incident-list-time small{font-size:12px;color:var(--i7y-muted,#71717a)}.incident-overdue{color:var(--q-negative)!important}.incidents-table :deep(.q-badge){font-size:12px;line-height:18px;padding:2px 8px}.incidents-table :deep(td){vertical-align:middle}.incidents-table :deep(td>.monitoring-secondary){margin-top:4px}.incident-list-footer{display:flex;justify-content:space-between;gap:16px;padding:12px 16px;border-top:1px solid rgba(127,127,127,.18);font-size:13px;color:var(--i7y-muted,#71717a)}
.incident-summary{margin-bottom:20px}.incident-summary-heading{padding:24px;display:flex;align-items:flex-start;justify-content:space-between;gap:24px}.incident-summary-context{display:flex;flex-direction:column;gap:10px;min-width:0}.incident-badges{display:flex;gap:8px;flex-wrap:wrap}.incident-resource{font-size:16px;font-weight:500;overflow-wrap:anywhere}.incident-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;padding:20px 24px;gap:24px;border-top:1px solid rgba(127,127,127,.18)}.incident-facts dt,.incident-mobile-facts dt{font-size:12px;color:var(--i7y-muted,#71717a);margin-bottom:6px}.incident-facts dd,.incident-mobile-facts dd{margin:0;font-size:14px;line-height:1.6;overflow-wrap:anywhere}.incident-resolution{margin:0;padding:0 24px 20px;font-size:14px}.incident-detail-layout{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:20px;align-items:start}.incident-supporting{display:grid;gap:16px;min-width:0}.incident-section-heading{padding:20px 24px;border-bottom:1px solid rgba(127,127,127,.18)}.incident-section-heading h2{margin:0;font-size:16px;font-weight:600;line-height:24px}.incident-events{list-style:none;margin:0;padding:0 24px}.incident-events>li{padding:20px 0;border-bottom:1px solid rgba(127,127,127,.15)}.incident-events>li:last-child{border-bottom:0}.incident-event-heading{display:flex;align-items:baseline;justify-content:space-between;gap:16px}.incident-event-heading strong{font-size:14px;font-weight:500}.incident-event-heading time{font-size:12px;line-height:20px;color:var(--i7y-muted,#71717a);text-align:right}.incident-events p{margin:8px 0 0}.incident-event-details{margin-top:8px;font-size:13px;border-radius:8px;overflow:hidden}.incident-event-details :deep(.q-item){padding:8px 12px;min-height:40px;border-radius:8px}.incident-event-details :deep(.q-focus-helper){border-radius:inherit}.incident-technical-content{padding:16px;font-size:13px;margin:0}.incident-technical-content>div{margin-bottom:16px}.incident-technical-content>div:last-child{margin-bottom:0}.incident-technical-content dt,.incident-technical-content p>span{display:block;color:var(--i7y-muted,#71717a);font-size:12px;margin-bottom:6px}.incident-technical-content dd{margin:0;overflow-wrap:anywhere}.incident-json{margin:0;font-size:12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;max-height:480px;overflow:auto}.incident-evidence-content{padding:16px}.incident-empty{padding:24px;margin:0;color:var(--i7y-muted,#71717a)}.incident-claim-dialog{width:520px;max-width:calc(100vw - 32px)}.incident-notice{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:10px}
.incident-mobile-card{width:100%;min-width:0}.incident-mobile-badges{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}.incident-mobile-resource{margin:6px 0 0}.incident-mobile-facts{display:grid;gap:14px;margin:20px 0 0;padding-top:16px;border-top:1px solid rgba(127,127,127,.15)}.incidents-table :deep(.q-table__grid-content){display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:12px}
@media(max-width:1023px){.incident-detail-layout{grid-template-columns:minmax(0,1fr)}.incident-facts{grid-template-columns:repeat(2,minmax(0,1fr))}.incident-toolbar .monitoring-search{flex-basis:100%;max-width:none}.incident-toolbar .monitoring-filter{flex:1;min-width:130px;width:auto}.incident-search-submit{display:none}.incident-summary-heading{padding:20px}.incident-facts{padding:20px}.incident-events{padding:0 20px}.incident-section-heading{padding:20px}.incident-filter-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:599px){.incident-filter-grid,.incident-facts{grid-template-columns:minmax(0,1fr)}.incident-filter-footer{align-items:flex-start;flex-direction:column}.incident-filter-actions{align-self:flex-end}.incident-event-heading{align-items:flex-start;flex-direction:column;gap:4px}.incident-event-heading time{text-align:left}.incident-list-footer{flex-wrap:wrap}.incident-summary-heading{gap:12px}}
</style>
