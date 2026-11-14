<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { useQuasar } from 'quasar'
import { addConnection, renameConnection, logoutConnection, removeConnection, retryConnection, connectionRevision, loadOrganizations, selectConnection } from '../api'
import { desktopConnections, activeConnectionId } from '../desktop-backend'
import { connectionClients, loadConnectionOrganizations } from '../connection-clients'
import { browserSignIn } from '../desktop-auth'
import { normalizeBackendUrl } from '../backend-url'
import { t } from '../i18n'
const emit=defineEmits(['selected'])
const q=useQuasar(),opened=ref(false),name=ref(''),url=ref(''),busy=ref(''),error=ref(''),code=ref('')
let abort=new AbortController()
const rows=computed(()=>{connectionRevision.value;return desktopConnections.value.map(connection=>({...connection,source:connectionClients().find(source=>source.id===connection.id)}))})
async function add(){
  if(busy.value)return
  busy.value='add';error.value=''
  try {const connection=await addConnection(normalizeBackendUrl(url.value),name.value);url.value='';name.value='';await login(connection.id)}catch{error.value=t('connections.addError')}finally{busy.value=''}
}
async function login(id:string){
  busy.value=id;error.value='';abort=new AbortController()
  try {await browserSignIn(abort.signal,value=>code.value=value,id);if(!abort.signal.aborted){await loadConnectionOrganizations(id);if(!activeConnectionId.value){await selectConnection(id);await loadOrganizations();emit('selected',id)}}}
  catch {if(!abort.signal.aborted)error.value=t('connections.loginError')}
  finally {busy.value='';code.value=''}
}
async function useConnection(id:string){
  busy.value=id;error.value=''
  try{await selectConnection(id);emit('selected',id);opened.value=false}catch{error.value=t('connections.actionError')}finally{busy.value=''}
}
function rename(row:any){q.dialog({title:t('connections.rename'),prompt:{model:row.name,type:'text',isValid:value=>!!value.trim() && value.length<=160},cancel:true}).onOk(async value=>{try{await renameConnection(row.id,value)}catch{error.value=t('connections.actionError')}})}
async function logout(id:string){busy.value=id;try{await logoutConnection(id)}catch{error.value=t('connections.actionError')}finally{busy.value=''}}
function remove(row:any){q.dialog({title:t('connections.remove'),message:row.name+' · '+row.url,cancel:true}).onOk(async()=>{busy.value=row.id;try{await removeConnection(row.id);emit('selected',activeConnectionId.value)}catch{error.value=t('connections.actionError')}finally{busy.value=''}})}
async function retry(id:string){busy.value=id;try{await retryConnection(id)}finally{busy.value=''}}
onUnmounted(()=>abort.abort())
</script>
<template>
  <q-btn flat round dense icon="dns" :aria-label="t('connections.manage')" @click="opened=true"><q-tooltip>{{t('connections.manage')}}</q-tooltip></q-btn>
  <q-dialog v-model="opened" @hide="abort.abort()"><q-card class="connections-dialog">
    <q-card-section class="row items-center"><h2 class="text-h6 q-my-none">{{t('connections.title')}}</h2><q-space/><q-btn flat round dense icon="close" v-close-popup :aria-label="t('Close')"/></q-card-section>
    <q-card-section class="q-pt-none"><p class="text-grey-7">{{t('connections.help')}}</p><q-banner v-if="error" class="bg-red-1 text-negative q-mb-md" role="alert">{{error}}</q-banner>
      <q-list bordered separator class="rounded-borders"><q-item v-for="row in rows" :key="row.id"><q-item-section><q-item-label>{{row.name}} <q-badge v-if="row.id===activeConnectionId" outline color="primary">{{t('connections.selected')}}</q-badge></q-item-label><q-item-label caption class="connection-url">{{row.url}}</q-item-label><q-item-label caption>{{row.source?.client.authStore.record?.email || t(row.source?.unavailable?'connections.unavailable':'connections.signedOut')}}</q-item-label><div class="row q-gutter-xs q-mt-sm"><q-btn v-if="row.source?.client.authStore.isValid" flat dense no-caps :label="t('connections.select')" :disable="!!busy" @click="useConnection(row.id)"/><q-btn v-else flat dense no-caps color="primary" :label="t('Sign in with browser')" :disable="!!busy" @click="login(row.id)"/><q-btn v-if="row.source?.unavailable" flat dense no-caps :label="t('Try again')" :disable="!!busy" @click="retry(row.id)"/><q-btn flat dense no-caps :label="t('connections.rename')" :disable="!!busy" @click="rename(row)"/><q-btn v-if="row.source?.client.authStore.isValid" flat dense no-caps :label="t('Sign out')" :disable="!!busy" @click="logout(row.id)"/><q-btn flat dense no-caps color="negative" :label="t('connections.remove')" :disable="!!busy" @click="remove(row)"/></div></q-item-section><q-item-section v-if="busy===row.id" side><q-spinner color="primary"/></q-item-section></q-item><q-item v-if="!rows.length"><q-item-section>{{t('connections.empty')}}</q-item-section></q-item></q-list>
      <q-banner v-if="code" class="q-mt-md">{{t('Waiting for authorization in your browser.')}} <strong>{{code}}</strong><template #action><q-btn flat no-caps :label="t('Cancel')" @click="abort.abort()"/></template></q-banner>
      <q-form class="q-gutter-y-md q-mt-md" @submit="add"><h3 class="text-subtitle1 q-my-none">{{t('connections.add')}}</h3><q-input v-model="name" outlined :label="t('Name')" maxlength="160" :disable="!!busy"/><q-input v-model="url" outlined type="url" :label="t('Backend URL')" placeholder="https://inventory.example.com" autocomplete="url" spellcheck="false" :disable="!!busy"/><q-btn type="submit" color="primary" no-caps :label="t('connections.addLogin')" :disable="!url.trim() || !!busy" :loading="busy==='add'"/></q-form>
    </q-card-section>
  </q-card></q-dialog>
</template>
<style scoped>.connections-dialog{width:700px;max-width:calc(100vw - 32px)}.connection-url{overflow-wrap:anywhere}</style>
