<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { tokenApi, activeOrganization, organizationChoices, globalAdmin } from '../api'
import { t, locale } from '../i18n'
const props = defineProps({route:Object,authenticated:Boolean})
const q = useQuasar()
const tokens = ref([]), loading = ref(false), busy = ref(false), error = ref(''), secret = ref('')
const form = ref({label:'',scope:'read',days:30})
const canWrite = computed(()=>globalAdmin.value || ['admin','editor'].includes(organizationChoices.value.find(r=>r.id===activeOrganization.value)?.role))
const scopeOptions=computed(()=>[{label:t('Read only'),value:'read'},...(canWrite.value?[{label:t('Read and write'),value:'write'}]:[])])
const selected = computed(()=>tokens.value.find(token=>token.id===props.route.id))
const columns = computed(()=>[
  {name:'label',label:t('Name'),field:'label',align:'left' as const},
  {name:'prefix',label:t('Token prefix'),field:'prefix',align:'left' as const},
  {name:'scope',label:t('Permission'),field:row=>t(row.scope==='read'?'Read only':'Read and write'),align:'left' as const},
  {name:'expires',label:t('Expires'),field:row=>new Date(row.expires_at.replace(' ','T')).toLocaleString(locale.value),align:'left' as const},
  {name:'action',label:'',field:'id'},
])
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
    <div class="page-heading"><h1>{{t(route.action==='new'?'Create API token':route.action==='revoke'?'Revoke API token':'API tokens')}}</h1><q-btn v-if="route.action!=='list'" flat no-caps icon="arrow_back" :label="t('API tokens')" href="#/tokens" :disable="busy" /><q-btn v-else-if="authenticated" unelevated color="primary" no-caps icon="add" :label="t('Create API token')" href="#/tokens/new" /></div>
    <q-banner v-if="error" class="bg-red-1 text-negative q-mb-md rounded-borders" role="alert">{{error}}</q-banner>
    <q-card v-if="!authenticated" flat bordered class="q-pa-lg"><p>{{t('Sign in to manage your API tokens.')}}</p><q-btn color="primary" no-caps :label="t('Sign in')" href="#/login" /></q-card>
    <q-card v-else-if="route.action==='new'" flat bordered class="token-form-card">
      <q-card-section v-if="secret" class="q-pa-lg q-gutter-y-md">
        <h2 class="text-h6 q-ma-none">{{t('Token created')}}</h2>
        <p>{{t('Copy this token now. It will not be shown again.')}}</p>
        <q-input :model-value="secret" outlined readonly autogrow type="textarea" :label="t('API token')" />
        <q-btn unelevated color="primary" icon="content_copy" no-caps :label="t('Copy token')" @click="copy" />
        <p class="text-caption">{{t('Send it as Authorization: Bearer TOKEN. Keep your password private.')}}</p>
        <q-btn flat no-caps :label="t('API tokens')" href="#/tokens" />
      </q-card-section>
      <q-form v-else @submit="create" class="q-pa-lg q-gutter-y-md">
        <p>{{t('Create a separate token for each agent. It only accesses inventory records.')}}</p>
        <q-input v-model="form.label" outlined :label="t('Name')" :hint="t('For example: inventory review agent')" maxlength="80" :rules="[value=>!!value?.trim() || t('Required field')]" autofocus />
        <q-select v-model="form.scope" outlined emit-value map-options :label="t('Permission')" :options="scopeOptions" />
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
    <q-card v-else flat bordered>
      <q-card-section><p class="q-mb-none">{{t('Share a token with an agent instead of your email and password. Revoke it here when the work is done.')}}</p><p class="text-caption text-grey-7 q-mb-none">{{t('These tokens do not access users, settings or token creation.')}}</p></q-card-section>
      <q-table flat :rows="tokens" :columns="columns" row-key="id" :loading="loading" :pagination="{rowsPerPage:10}" :no-data-label="t('No API tokens yet')">
        <template #body-cell-prefix="props"><q-td :props="props"><code>{{props.value}}…</code></q-td></template>
        <template #body-cell-expires="props"><q-td :props="props">{{props.value}}<q-badge v-if="expired(props.row)" color="grey" class="q-ml-sm">{{t('Expired')}}</q-badge></q-td></template>
        <template #body-cell-action="props"><q-td :props="props"><q-btn flat color="negative" no-caps icon="block" :label="t('Revoke')" :href="`#/tokens/${props.row.id}/revoke`" /></q-td></template>
      </q-table>
    </q-card>
  </q-page>
</template>

<style scoped>
.token-form-card {max-width:760px;margin:0 auto 24px}
.token-form-card code {overflow-wrap:anywhere}
</style>
