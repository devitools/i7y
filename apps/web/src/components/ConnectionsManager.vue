<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { addConnection, renameConnection, logoutConnection, removeConnection, retryConnection, connectionRevision, loadOrganizations, selectConnection } from '../api'
import { desktopConnections, activeConnectionId } from '../desktop-backend'
import { connectionClients, loadConnectionOrganizations } from '../connection-clients'
import { browserSignIn } from '../desktop-auth'
import { normalizeBackendUrl } from '../backend-url'
import { connectionsHash } from '../routes'
import { leadingRowActions } from '../table-columns'
import type { RouteState } from '../types'
import { t } from '../i18n'
import PageHeader from './PageHeader.vue'
import PageActions from './PageActions.vue'
const props=defineProps<{route?:RouteState}>()
const emit=defineEmits(['selected','back'])
const q=useQuasar(),name=ref(''),url=ref(''),search=ref(''),busy=ref(''),error=ref(''),code=ref('')
let abort:AbortController|null=null,viewGeneration=0,pendingLogin:string|null=null
const action=computed(()=>props.route?.action || 'list')
const listing=computed(()=>action.value==='list')
const rows=computed(()=>{connectionRevision.value;return desktopConnections.value.map(connection=>({...connection,source:connectionClients().find(source=>source.id===connection.id)}))})
const selected=computed(()=>rows.value.find(row=>row.id===props.route?.id))
const listHash=computed(()=>connectionsHash('list',null,props.route?.returnTo))
const title=computed(()=>t(listing.value?'connections.title':action.value==='new'?'connections.add':action.value==='edit'?'connections.edit':'connections.remove'))
const breadcrumbs=computed(()=>listing.value?undefined:[{label:t('connections.title'),href:listHash.value}])
const backendValid=computed(()=>{try{return !!normalizeBackendUrl(url.value)}catch{return false}})
const validBackend=(value:string)=>{try{return !!normalizeBackendUrl(value)}catch{return t('connections.invalidUrl')}}
const required=(value:string)=>!!String(value || '').trim() || t('Required field')
function showUrl(row:{name:string;url:string}){try{const address=new URL(row.url);return row.name.trim().toLowerCase()!==address.host.toLowerCase() || address.pathname!=='/'}catch{return true}}
const account=(row:any)=>row.source?.client.authStore.isValid?row.source.client.authStore.record?.email || '—':t('connections.signedOut')
const columns=computed(()=>leadingRowActions([
  {name:'name',label:t('connections.backend'),field:row=>row.name+' '+row.url,align:'left' as const,sortable:true},
  {name:'account',label:t('Email'),field:account,align:'left' as const,sortable:true},
  {name:'access',label:'',field:row=>row.source?.unavailable?t('connections.unavailableShort'):'',align:'right' as const},
  {name:'action',label:'',field:'id',align:'left' as const},
]))
function rowActions(row:any){return [
  {label:t('connections.edit'),icon:'edit',color:'grey-7',href:connectionsHash('edit',row.id,props.route?.returnTo)},
  {label:t('connections.remove'),icon:'delete_outline',color:'negative',href:connectionsHash('remove',row.id,props.route?.returnTo)},
  ...(row.source?.client.authStore.isValid?[{label:t('Sign out'),icon:'power_settings_new',color:'grey-7',onClick:()=>logout(row.id),href:undefined}]:[]),
]}
function navigateList(){window.location.hash=listHash.value}
async function add(){
  if(busy.value||action.value!=='new'||!backendValid.value)return
  const generation=viewGeneration,sourceHash=window.location.hash
  busy.value='add';error.value=''
  try {
    const connection=await addConnection(normalizeBackendUrl(url.value),name.value.trim())
    if(generation!==viewGeneration||window.location.hash!==sourceHash)return
    pendingLogin=connection.id;navigateList()
  }catch{if(generation===viewGeneration)error.value=t('connections.addError')}
  finally{if(generation===viewGeneration)busy.value=''}
}
async function login(id:string){
  if(busy.value||!listing.value)return
  const controller=new AbortController(),generation=viewGeneration,sourceHash=window.location.hash
  abort=controller;busy.value=id;error.value='';code.value=''
  try {
    await browserSignIn(controller.signal,value=>{if(window.location.hash!==sourceHash)controller.abort();if(abort===controller&&generation===viewGeneration&&!controller.signal.aborted)code.value=value},id)
    if(controller.signal.aborted||generation!==viewGeneration||window.location.hash!==sourceHash)return
    await loadConnectionOrganizations(id)
    if(!controller.signal.aborted&&generation===viewGeneration&&window.location.hash===sourceHash&&!activeConnectionId.value){await selectConnection(id);await loadOrganizations();if(!controller.signal.aborted&&generation===viewGeneration&&window.location.hash===sourceHash)emit('selected',id)}
  }catch{if(!controller.signal.aborted&&generation===viewGeneration)error.value=t('connections.loginError')}
  finally{if(abort===controller){abort=null;if(generation===viewGeneration){busy.value='';code.value=''}}}
}
async function save(){
  const row=selected.value,generation=viewGeneration
  if(busy.value||action.value!=='edit'||!row||!name.value.trim()||name.value.trim().length>160)return
  busy.value=row.id;error.value=''
  try{await renameConnection(row.id,name.value.trim());if(generation===viewGeneration)navigateList()}
  catch{if(generation===viewGeneration)error.value=t('connections.actionError')}
  finally{if(generation===viewGeneration)busy.value=''}
}
async function logout(id:string){
  if(busy.value)return
  const generation=viewGeneration;busy.value=id;error.value=''
  try{await logoutConnection(id)}catch{if(generation===viewGeneration)error.value=t('connections.actionError')}finally{if(generation===viewGeneration)busy.value=''}
}
async function remove(){
  const row=selected.value,generation=viewGeneration,sourceHash=window.location.hash,returnHash=listHash.value
  if(busy.value||action.value!=='remove'||!row)return
  busy.value=row.id;error.value=''
  try{await removeConnection(row.id);if(window.location.hash===sourceHash){if(generation===viewGeneration)emit('selected',activeConnectionId.value);window.location.hash=returnHash}}
  catch{if(generation===viewGeneration)error.value=t('connections.actionError')}
  finally{if(generation===viewGeneration)busy.value=''}
}
async function retry(id:string){
  if(busy.value)return
  const generation=viewGeneration;busy.value=id;error.value=''
  try{await retryConnection(id)}catch{if(generation===viewGeneration)error.value=t('connections.actionError')}finally{if(generation===viewGeneration)busy.value=''}
}
watch(()=>[action.value,props.route?.id,props.route?.returnTo],()=>{
  const resume=listing.value?pendingLogin:null
  pendingLogin=null;viewGeneration++;abort?.abort();abort=null;busy.value='';error.value='';code.value=''
  name.value=selected.value?.name || '';url.value=selected.value?.url || ''
  if(resume)void login(resume)
},{immediate:true})
onUnmounted(()=>{viewGeneration++;pendingLogin=null;abort?.abort()})
</script>
<template>
  <q-page class="q-pa-md inventory-page connections-page">
    <PageHeader :title="title" :breadcrumbs="breadcrumbs"/>
    <q-banner v-if="error" class="error-banner rounded-borders" role="alert">{{error}}</q-banner>
    <template v-if="listing">
      <p class="connections-help">{{t('connections.help')}}</p>
      <q-card flat bordered class="data-panel">
        <div class="inventory-controls container-controls connections-toolbar">
          <div class="inventory-actions">
            <q-input v-model="search" outlined dense clearable :placeholder="t('Search')" :aria-label="t('Search')" class="search-input"><template #prepend><q-icon name="search" size="21px"/></template></q-input>
            <q-space/>
            <PageActions :actions="[{label:t('connections.add'),icon:'add',disable:!!busy,href:connectionsHash('new',null,route?.returnTo)}]"/>
          </div>
        </div>
        <q-banner v-if="code" class="connection-authorization" role="status" aria-live="polite"><span>{{t('Waiting for authorization in your browser.')}}</span><strong>{{code}}</strong><template #action><q-btn flat no-caps :label="t('Cancel')" @click="abort?.abort()"/></template></q-banner>
        <q-table flat class="inventory-table connections-table" :grid="q.screen.lt.md" :rows="rows" :columns="columns" :filter="search" row-key="id" :pagination="{rowsPerPage:10}" :rows-per-page-options="[10,25,50]">
          <template #body-cell-action="slot"><q-td :props="slot"><div class="page-actions connection-row-actions"><q-btn v-for="item in rowActions(slot.row)" :key="item.icon" flat round dense :icon="item.icon" :color="item.color" :href="item.href" :disable="!!busy" :aria-label="item.label+': '+slot.row.name" @click="item.onClick"><q-tooltip>{{item.label}}</q-tooltip></q-btn></div></q-td></template>
          <template #body-cell-name="slot"><q-td :props="slot"><strong class="connection-name">{{slot.row.name}}</strong><small v-if="showUrl(slot.row)" class="connection-url">{{slot.row.url}}</small></q-td></template>
          <template #body-cell-account="slot"><q-td :props="slot"><span class="connection-account">{{account(slot.row)}}</span></q-td></template>
          <template #body-cell-access="slot"><q-td :props="slot"><div class="connection-access"><q-spinner v-if="busy===slot.row.id" color="primary" size="20px" :aria-label="t('Loading')"/><template v-else><span v-if="slot.row.source?.unavailable" class="connection-unavailable">{{t('connections.unavailableShort')}}</span><q-btn v-if="!slot.row.source?.client.authStore.isValid" flat dense no-caps color="primary" :label="t('Sign in')" :disable="!!busy" @click="login(slot.row.id)"/><q-btn v-if="slot.row.source?.unavailable" flat dense no-caps :label="t('Try again')" :disable="!!busy" @click="retry(slot.row.id)"/></template></div></q-td></template>
          <template #item="slot"><q-card flat bordered class="connection-mobile-card"><q-card-section><div class="connection-mobile-heading"><div class="page-actions connection-row-actions"><q-btn v-for="item in rowActions(slot.row)" :key="item.icon" flat round dense :icon="item.icon" :color="item.color" :href="item.href" :disable="!!busy" :aria-label="item.label+': '+slot.row.name" @click="item.onClick"><q-tooltip>{{item.label}}</q-tooltip></q-btn></div><div class="connection-mobile-identity"><strong class="connection-name">{{slot.row.name}}</strong><small v-if="showUrl(slot.row)" class="connection-url">{{slot.row.url}}</small><span class="connection-mobile-account">{{account(slot.row)}}</span></div></div><div class="connection-access connection-mobile-access"><q-spinner v-if="busy===slot.row.id" color="primary" size="20px" :aria-label="t('Loading')"/><template v-else><span v-if="slot.row.source?.unavailable" class="connection-unavailable">{{t('connections.unavailableShort')}}</span><q-btn v-if="!slot.row.source?.client.authStore.isValid" flat dense no-caps color="primary" :label="t('Sign in')" :disable="!!busy" @click="login(slot.row.id)"/><q-btn v-if="slot.row.source?.unavailable" flat dense no-caps :label="t('Try again')" :disable="!!busy" @click="retry(slot.row.id)"/></template></div></q-card-section></q-card></template>
          <template #no-data><div class="empty-state"><h3>{{t(rows.length?'No records in this selection':'connections.empty')}}</h3></div></template>
        </q-table>
      </q-card>
    </template>
    <q-banner v-else-if="action!=='new'&&!selected" class="q-mb-md" role="alert">{{t('Record not found')}}</q-banner>
    <q-card v-else flat bordered class="management-card connection-form">
      <q-form @submit="action==='new'?add():action==='edit'?save():remove()" class="q-pa-lg q-gutter-y-md">
        <template v-if="action==='remove'&&selected"><h2 class="text-h6 q-my-none">{{selected.name}}</h2><p class="connection-remove-url">{{selected.url}}</p><p>{{t('connections.removeHelp')}}</p></template>
        <div v-else class="connection-form-fields">
          <q-input v-model="url" outlined type="url" :label="t('Backend URL')" placeholder="https://inventory.example.com" autocomplete="url" spellcheck="false" :autofocus="action==='new'" :readonly="action==='edit'" :disable="!!busy" :rules="action==='new'?[validBackend]:undefined" :hint="action==='edit'?t('connections.urlReadOnly'):undefined" class="connection-url-field" lazy-rules/>
          <q-input v-model="name" outlined :label="t(action==='new'?'connections.nameOptional':'Name')" maxlength="160" :autofocus="action==='edit'" :disable="!!busy" :rules="action==='edit'?[required]:undefined" class="connection-name-field"/>
        </div>
        <div class="row justify-end q-gutter-sm q-pt-md"><q-btn flat no-caps :label="t('Cancel')" :href="listHash" :disable="!!busy"/><q-btn type="submit" unelevated no-caps :color="action==='remove'?'negative':'primary'" :icon="action==='remove'?'delete_outline':action==='edit'?'save':undefined" :label="t(action==='new'?'connections.addLogin':action==='edit'?'Save':'connections.remove')" :disable="!!busy || action==='new'&&!backendValid || action==='edit'&&!name.trim()" :loading="!!busy"/></div>
      </q-form>
    </q-card>
  </q-page>
</template>
<style scoped>
.connections-help{margin:0 0 16px;color:var(--i7y-muted,#71717a);font-size:13px;line-height:20px}
.connections-toolbar .inventory-actions{width:100%;gap:12px;flex-wrap:wrap}.connections-toolbar .search-input{width:320px;max-width:100%}
.connection-row-actions{display:flex;gap:4px;flex-wrap:nowrap}.connection-name{display:block;font-size:13px;line-height:20px;font-weight:500;overflow-wrap:anywhere}.connection-url{display:block;margin-top:4px;font-size:12px;line-height:18px;color:var(--i7y-muted,#71717a);overflow-wrap:anywhere;white-space:normal}.connection-account{overflow-wrap:anywhere}
.connection-access{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;min-height:32px}.connection-unavailable{font-size:12px;color:var(--q-negative)}.connection-access>.q-btn{min-height:30px;padding-inline:8px;font-size:12px}
.connection-authorization{background:var(--i7y-navigation-active,rgba(79,70,229,.06));color:var(--i7y-text,#18181b);border-bottom:1px solid var(--i7y-separator,#e4e4e7);font-size:13px}.connection-authorization strong{display:inline-block;margin-left:12px;font-size:15px;font-weight:500;letter-spacing:.08em}
.connection-form{width:100%;margin:0 0 24px}.connection-form-fields{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px}.connection-form-fields>.q-field{min-width:0}.connection-url-field{flex:2 1 360px}.connection-name-field{flex:1 1 240px}.connection-remove-url{color:var(--i7y-muted,#71717a);overflow-wrap:anywhere}
.connection-mobile-card{width:100%;margin:6px 0}.connection-mobile-heading{display:flex;align-items:flex-start;gap:12px}.connection-mobile-identity{min-width:0;flex:1}.connection-mobile-account{display:block;margin-top:8px;color:var(--i7y-muted,#71717a);font-size:12px;overflow-wrap:anywhere}.connection-mobile-access{margin-top:12px}.connection-mobile-access:empty{display:none}.connections-table :deep(.q-table__grid-content){display:block;padding:8px}
@media(max-width:599px){.connections-toolbar .search-input{width:100%}.connection-form-fields>.q-field{flex-basis:100%}.connection-form>.q-form{padding:16px}.connection-mobile-heading{gap:8px}.connection-row-actions{gap:0}.connection-authorization strong{display:block;margin:8px 0 0}}
</style>
