<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { tokenApi, activeOrganization, organizationChoices, globalAdmin } from '../api'
import { t, locale } from '../i18n'
import PageHeader from './PageHeader.vue'
import { leadingRowActions } from '../table-columns'
import PageActions from './PageActions.vue'
const props = defineProps({route:Object,authenticated:Boolean})
const q = useQuasar()
const tokens = ref([]), loading = ref(false), busy = ref(false), error = ref(''), secret = ref('')
const form = ref({label:'',scope:'read',days:30,capabilities:[]})
const canWrite = computed(()=>globalAdmin.value || ['admin','editor'].includes(organizationChoices.value.find(r=>r.id===activeOrganization.value)?.role))
const scopeOptions=computed(()=>[{label:t('Read only'),value:'read'},...(canWrite.value?[{label:t('Read and write'),value:'write'}]:[])])
const capabilityOptions=computed(()=>[
  {label:t('Read alerts'),value:'alerts:read'},
  {label:t('Read incidents'),value:'incidents:read'},
  ...(canWrite.value?[{label:t('Manage alerts'),value:'alerts:write'},{label:t('Create incidents'),value:'incidents:create'},{label:t('Resolve incidents'),value:'incidents:resolve'}]:[]),
])
function scopeLabel(value) { return value==='read' ? t('Read only') : value==='write' ? t('Read and write') : '—' }
function capabilityLabels(values = []) {
  const capabilities=Array.isArray(values)?values.filter(value=>typeof value==='string' && value.length>0):[]
  const labels={'alerts:read':'Read alerts','alerts:write':'Manage alerts','incidents:read':'Read incidents','incidents:create':'Create incidents','incidents:resolve':'Resolve incidents'}
  return capabilities.length ? capabilities.map(value=>t(labels[value] || value)).join(', ') : t('No additional permissions')
}
const selected = computed(()=>tokens.value.find(token=>token.id===props.route.id))
const columns = computed(()=>leadingRowActions([
  {name:'label',label:t('Name'),field:'label',align:'left' as const},
  {name:'prefix',label:t('Token prefix'),field:'prefix',align:'left' as const},
  {name:'scope',label:t('Inventory permission'),field:row=>scopeLabel(row.scope),align:'left' as const},
  {name:'capabilities',label:t('Additional API permissions'),field:row=>capabilityLabels(row.capabilities),align:'left' as const,style:'white-space:normal;max-width:280px'},
  {name:'expires',label:t('Expires'),field:row=>new Date(row.expires_at.replace(' ','T')).toLocaleString(locale.value),align:'left' as const},
  {name:'action',label:'',field:'id'},
]))
const expired = token => Date.parse(token.expires_at.replace(' ','T')) <= Date.now()
async function load() {
  error.value=''; secret.value=''
  if (!props.authenticated) return
  loading.value=true
  try { tokens.value=(await tokenApi.list()).items }
  catch { error.value=t('Unable to load API tokens. Sign in again or try refreshing.') }
  finally { loading.value=false }
}
watch(()=>[props.route.action,props.route.id,props.authenticated].join(':'),load,{immediate:true})
async function create() {
  if (busy.value) return
  busy.value=true; error.value=''
  try { const result=await tokenApi.create(form.value); secret.value=result.token }
  catch { error.value=t('Unable to create the token. Check your session and the limit of 100 tokens.') }
  finally { busy.value=false }
}
async function revoke() {
  if (busy.value || !selected.value) return
  busy.value=true; error.value=''
  try {
    await tokenApi.revoke(selected.value.id)
    q.notify({type:'positive',message:t('Token revoked')})
    window.location.hash='#/tokens'
  } catch { error.value=t('Unable to revoke this token. Try again.') }
  finally { busy.value=false }
}
async function copy() {
  try { await navigator.clipboard.writeText(secret.value); q.notify({type:'positive',message:t('Copied to clipboard')}) }
  catch { error.value=t('Unable to copy. Select the text manually.') }
}
</script>

<template>
  <q-page class="q-pa-md inventory-page">
    <PageHeader :title="t(route.action==='new'?'Create API token':route.action==='revoke'?'Revoke API token':'API tokens')" />
    <q-banner v-if="error" class="bg-red-1 text-negative q-mb-md rounded-borders" role="alert">{{error}}</q-banner>
    <q-card v-if="!authenticated" flat bordered class="q-pa-lg"><p>{{t('Sign in to manage your API tokens.')}}</p><q-btn color="primary" no-caps :label="t('Sign in')" href="#/login" /></q-card>
    <q-card v-else-if="route.action==='new'" flat bordered class="token-form-card">
      <q-card-section v-if="secret" class="q-pa-lg q-gutter-y-md">
        <h2 class="text-h6 q-ma-none">{{t('Token created')}}</h2>
        <p>{{t('Copy this token now. It will not be shown again.')}}</p>
        <q-input :key="q.screen.width" :model-value="secret" outlined readonly autogrow type="textarea" :label="t('API token')" />
        <q-btn unelevated color="primary" icon="content_copy" no-caps :label="t('Copy token')" @click="copy" />
        <p class="text-caption">{{t('Send it as Authorization: Bearer TOKEN. Keep your password private.')}}</p>
        <q-btn flat no-caps :label="t('API tokens')" href="#/tokens" />
      </q-card-section>
      <q-form v-else @submit="create" class="q-pa-lg q-gutter-y-md">
        <p>{{t('Create a separate token for each integration. Select only the permissions it needs.')}}</p>
        <q-input v-model="form.label" outlined :label="t('Name')" :hint="t('For example: inventory review agent')" maxlength="80" :rules="[value=>!!value?.trim() || t('Required field')]" autofocus />
        <q-select v-model="form.scope" outlined emit-value map-options :label="t('Inventory permission')" :options="scopeOptions" />
        <q-select v-model="form.capabilities" multiple use-chips outlined emit-value map-options :label="t('Additional API permissions')" :options="capabilityOptions" />
        <q-input v-model.number="form.days" outlined type="number" min="1" max="365" :label="t('Validity in days')" :rules="[value=>Number.isInteger(Number(value)) && Number(value)>=1 && Number(value)<=365 || t('Use 1 to 365 days')]" />
        <p class="text-caption text-grey-7">{{t('Read and write applies only to the selected organization.')}}</p>
        <div class="row justify-end q-gutter-sm"><q-btn flat no-caps :label="t('Cancel')" href="#/tokens" :disable="busy" /><q-btn type="submit" unelevated color="primary" icon="key" no-caps :label="t('Create API token')" :loading="busy" /></div>
      </q-form>
    </q-card>
    <q-card v-else-if="route.action==='revoke'" flat bordered class="token-form-card q-pa-lg">
      <q-spinner v-if="loading" color="primary" />
      <template v-else-if="selected"><h2 class="text-h6 q-mt-none">{{selected.label}}</h2><p>{{t('This agent will lose access immediately. Other tokens and your login will keep working.')}}</p><code>{{selected.prefix}}…</code><div class="row justify-end q-gutter-sm q-mt-lg"><q-btn flat no-caps :label="t('Cancel')" href="#/tokens" :disable="busy" /><q-btn unelevated color="negative" no-caps icon="block" :label="t('Revoke API token')" :loading="busy" @click="revoke" /></div></template>
      <p v-else>{{t('Token not found. It may already have been revoked.')}}</p>
    </q-card>
    <q-card v-else flat bordered><div class="inventory-actions"><PageActions :actions="route.action==='list' && authenticated ? [{label:t('Create API token'),icon:'add',href:'#/tokens/new'}] : []" /></div>
      <q-card-section><p class="q-mb-none">{{t('Share a token with an agent instead of your email and password. Revoke it here when the work is done.')}}</p><p class="text-caption text-grey-7 q-mb-none">{{t('These tokens do not access users, settings or token creation.')}}</p></q-card-section>
      <q-table flat class="token-table" :grid="q.screen.lt.md" :rows="tokens" :columns="columns" row-key="id" :loading="loading" :pagination="{rowsPerPage:10}" :no-data-label="t('No API tokens yet')">
        <template #item="slot"><q-card flat bordered class="token-mobile-card"><q-card-section><div class="row items-start no-wrap q-gutter-sm"><strong class="col token-card-title">{{slot.row.label}}</strong><PageActions :actions="[{label:t('Revoke'),icon:'block',color:'negative',href:`#/tokens/${slot.row.id}/revoke`}]" /></div><code>{{slot.row.prefix}}…</code><dl class="token-card-meta"><div><dt>{{t('Inventory permission')}}</dt><dd>{{scopeLabel(slot.row.scope)}}</dd></div><div><dt>{{t('Additional API permissions')}}</dt><dd>{{capabilityLabels(slot.row.capabilities)}}</dd></div><div><dt>{{t('Expires')}}</dt><dd>{{new Date(slot.row.expires_at.replace(' ','T')).toLocaleString(locale)}} <q-badge v-if="expired(slot.row)" color="grey">{{t('Expired')}}</q-badge></dd></div></dl></q-card-section></q-card></template>
        <template #body-cell-prefix="props"><q-td :props="props"><code>{{props.value}}…</code></q-td></template>
        <template #body-cell-expires="props"><q-td :props="props">{{props.value}}<q-badge v-if="expired(props.row)" color="grey" class="q-ml-sm">{{t('Expired')}}</q-badge></q-td></template>
        <template #body-cell-action="props"><q-td :props="props"><q-btn flat color="negative" no-caps icon="block" :label="t('Revoke')" :href="`#/tokens/${props.row.id}/revoke`" /></q-td></template>
      </q-table>
    </q-card>
  </q-page>
</template>

<style scoped>
.token-form-card {width:100%;margin:0 0 24px}
.token-form-card code {overflow-wrap:anywhere}
.token-mobile-card{width:100%;margin:6px 0}.token-card-title{min-width:0;overflow-wrap:anywhere}.token-card-meta{display:grid;gap:12px;margin:16px 0 0}.token-card-meta dt{font-size:12px;color:var(--i7y-muted,#71717a)}.token-card-meta dd{margin:4px 0 0;overflow-wrap:anywhere}.token-table :deep(.q-table__grid-content){display:block;padding:8px}
</style>
