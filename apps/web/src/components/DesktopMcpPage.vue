<script setup lang="ts">
import {onMounted,onUnmounted,ref,computed,nextTick,watch} from 'vue'
import {invoke} from '@tauri-apps/api/core'
import {copyToClipboard} from 'quasar'
import {desktopRuntime,desktopBackend} from '../desktop-backend'
import {inventoryPage,pb,activeOrganization} from '../api'
import {t} from '../i18n'
import {approvalError,clientName,pendingRequests,requestState,requestTitle} from '../mcp-presentation'
import {requestTab} from '../mcp-requests'
import PageHeader from './PageHeader.vue'
import McpRequestReview from './McpRequestReview.vue'
const overview=ref<any>(null),error=ref(''),busy=ref(false),tab=ref('requests'),copied=ref(false)
const action=ref('server_inspect'),target=ref(null),targets=ref([]),operation=ref<any>(null),result=ref<any>(null)
const preparedSelection=ref('')
const contextKey=computed(()=>JSON.stringify([desktopBackend.value,activeOrganization.value,overview.value?.context]))
const selectionKey=computed(()=>JSON.stringify([contextKey.value,action.value,target.value]))
const canSubmit=computed(()=>!!operation.value?.operation_id && preparedSelection.value===selectionKey.value && operation.value.action===action.value.replaceAll('_','.') && operation.value.target===target.value)
const actions=['server_inspect','server_disk','container_list','container_start','container_stop','container_restart']
const actionLabels={server_inspect:'Inspect server',server_disk:'Inspect disk usage',container_list:'List containers',container_start:'Start container',container_stop:'Stop container',container_restart:'Restart container'}
const requests=computed(()=>[...pendingRequests(overview.value?.requests),...(overview.value?.requests || []).filter(p=>p.state==='executing')])
const pastRequests=computed(()=>(overview.value?.requests || []).filter(p=>!['approval_required','executing'].includes(p.state)).sort((a,b)=>b.expires_at-a.expires_at))
const history=ref<any[]>([])
let timer:ReturnType<typeof setInterval>|undefined
let refreshing=false,lastFocus='',alive=true,targetsLoaded=false
let preparationSequence=0
function clearOperation(){preparationSequence++;operation.value=null;result.value=null;preparedSelection.value=''}
watch(selectionKey,clearOperation,{flush:'sync'})
watch(contextKey,()=>{target.value=null;targets.value=[];if(targetsLoaded)void loadTargets()},{flush:'sync'})
function clientFor(request:any){return overview.value?.connections.find(client=>client.id===request.connection)?.client || request.arguments?.client}
async function loadHistory(){await perform(async()=>{history.value=(await pb.send('/api/i7y/mcp/v1/audit',{method:'GET',requestKey:null})).items})}
async function focusRequest(){
  const id=new URLSearchParams(window.location.hash.split('?')[1] || '').get('request')
  if(tab.value!=='requests' || !id || id===lastFocus)return
  await nextTick()
  const card=document.getElementById('request-'+id)
  if(card){card.scrollIntoView({block:'center'});lastFocus=id}
}
async function refresh(){
  if(!desktopRuntime || refreshing)return
  refreshing=true
  try{const state=await invoke('mcp_overview');if(alive){overview.value=state;await focusRequest()}}catch{if(alive)error.value=t('Unable to load desktop integration.')}finally{refreshing=false}
}
async function perform(fn:()=>Promise<unknown>){busy.value=true;error.value='';try{await fn();await refresh()}catch(cause){error.value=typeof cause==='string'?cause:t('Desktop request failed.')}finally{busy.value=false}}
async function toggle(enabled:boolean){await perform(()=>invoke('mcp_enable',{enabled}))}
async function decide(id:string,approve:boolean){busy.value=true;error.value='';try{await invoke('mcp_decide',{requestId:id,approve});await refresh()}catch(cause){error.value=approvalError(cause)}finally{busy.value=false}}
async function copyConfig(){await perform(async()=>{await copyToClipboard(overview.value.config);copied.value=true})}
async function loadTargets(){target.value=null;targets.value=[];clearOperation();const selection=JSON.stringify([contextKey.value,action.value]);try{const resource=action.value.startsWith('container_')&&action.value!=='container_list'?'containers':'servers';const page=await inventoryPage(resource,{perPage:100});if(alive&&selection===JSON.stringify([contextKey.value,action.value]))targets.value=page.items.map(item=>({label:[item.name,item.server?.name,item.ip].filter(Boolean).join(' / '),value:item.id}))}catch{if(alive&&selection===JSON.stringify([contextKey.value,action.value]))error.value=t('Unable to load targets.')}}
async function plan(){clearOperation();const selection=selectionKey.value,sequence=preparationSequence;await perform(async()=>{const inspect=['server_inspect','server_disk','container_list'].includes(action.value);const response=await invoke<any>('desktop_tool_call',{name:inspect?'inspect_resource':'plan_operation',arguments:{action:action.value,target:target.value}});if(!alive||sequence!==preparationSequence||selection!==selectionKey.value)return;result.value=response;operation.value=inspect?{operation_id:response.operation_id}:response.plan;preparedSelection.value=selection})}
async function submit(){if(!canSubmit.value){clearOperation();return}const operationId=operation.value.operation_id,selection=selectionKey.value,sequence=preparationSequence;await perform(async()=>{const response=await invoke('desktop_tool_call',{name:'submit_operation',arguments:{operation_id:operationId}});if(!alive||sequence!==preparationSequence||selection!==selectionKey.value)return;result.value=response;selectTab('requests')})}
async function status(){const operationId=operation.value?.operation_id;if(!operationId)return;const selection=selectionKey.value,sequence=preparationSequence;await perform(async()=>{const response=await invoke('desktop_tool_call',{name:'get_operation',arguments:{operation_id:operationId}});if(!alive||sequence!==preparationSequence||selection!==selectionKey.value)return;result.value=response})}
function selectTab(value:string){const hash='#/desktop/mcp?tab='+value;if(window.location.hash===hash)readTab();else window.location.hash=hash}
function readTab(){
  tab.value=requestTab(window.location.hash)
  if(tab.value==='history')void loadHistory()
  if(tab.value==='operations'&&!targetsLoaded&&desktopRuntime){targetsLoaded=true;void loadTargets()}
  void focusRequest()
}
onMounted(async()=>{window.addEventListener('hashchange',readTab);readTab();await refresh();timer=setInterval(refresh,1000)})
onUnmounted(()=>{alive=false;clearInterval(timer);window.removeEventListener('hashchange',readTab)})
</script>
<template>
  <q-page class="q-pa-md inventory-page">
    <PageHeader :title="t('Desktop integrations')" />
    <q-banner v-if="!desktopRuntime">{{t('Open this page in the desktop app.')}}</q-banner>
    <template v-else-if="overview">
      <q-banner v-if="error" rounded class="bg-negative text-white q-mb-md" role="alert">{{error}}</q-banner>
      <div class="mcp-service"><q-toggle :model-value="overview.enabled" :disable="busy || !overview.platform_supported" :label="t('Enable local MCP')" @update:model-value="toggle"/><p>{{t('Access requests appear automatically. Read access lasts 5 minutes; each change needs a new approval.')}}</p></div>
      <q-banner v-if="!overview.platform_supported">{{t('System authentication and MCP transport are not available on this platform yet.')}}</q-banner>
      <q-card flat bordered class="mcp-panel">
        <q-tabs :model-value="tab" align="left" dense no-caps active-color="primary" indicator-color="primary" class="panel-tabs" @update:model-value="selectTab">
          <q-tab name="requests"><span>{{t('Review requests')}}</span><q-badge v-if="requests.filter(p=>p.state==='approval_required').length" color="warning" class="q-ml-sm">{{requests.filter(p=>p.state==='approval_required').length}}</q-badge></q-tab><q-tab name="connections" :label="t('Connections')"/><q-tab name="operations" :label="t('Operations')"/><q-tab name="history" :label="t('History')"/>
        </q-tabs>
        <q-tab-panels v-model="tab" animated>
          <q-tab-panel name="requests">
            <div v-if="!requests.length" class="mcp-empty"><q-icon name="verified_user" size="32px" color="positive"/><h2>{{t('No requests waiting for your approval')}}</h2><p>{{t('When an agent needs access, i7y opens an authorization window automatically.')}}</p></div>
            <div v-else class="mcp-request-list"><McpRequestReview v-for="request in requests" :key="request.id" :request="request" :client="clientFor(request)" :organization="overview.organization_name" :authentication="overview.authorization_provider" :account="overview.user_label" :busy="busy" actions @decide="decide"/></div>
          </q-tab-panel>
          <q-tab-panel name="connections">
            <p>{{t('Client names are self-reported. Access is scoped to your selected backend and organization.')}}</p>
            <q-list v-if="overview.connections.length" bordered separator><q-item v-for="client in overview.connections" :key="client.id"><q-item-section><q-item-label>{{clientName(client.client)}}</q-item-label><q-item-label caption>{{overview.organization_name || t('Selected organization')}} · {{client.authorized?t('Read access authorized for 5 minutes'):t('Pending approval')}}</q-item-label><q-item-label v-if="client.authorized" caption>{{t('Expires')}}: {{new Date(client.authorization_expires_at*1000).toLocaleTimeString()}}</q-item-label></q-item-section><q-item-section side><q-btn no-caps flat :label="t('Revoke')" :disable="busy" @click="perform(()=>invoke('mcp_revoke',{connectionId:client.id}))"/></q-item-section></q-item></q-list>
            <p v-else>{{t('No agents connected.')}}</p>
            <q-expansion-item :label="t('Configure Codex')" icon="settings" class="q-mt-lg"><div class="q-pa-md"><q-input :model-value="overview.config" type="textarea" autogrow readonly outlined :label="t('Codex MCP configuration')"/><q-btn no-caps flat icon="content_copy" :label="copied?t('Copied'):t('Copy configuration')" @click="copyConfig"/></div></q-expansion-item>
          </q-tab-panel>
          <q-tab-panel name="history">
            <q-btn no-caps flat :loading="busy" :label="t('Refresh history')" @click="loadHistory"/>
            <q-list v-if="pastRequests.length" bordered separator><q-item v-for="request in pastRequests" :key="request.id"><q-item-section><q-item-label>{{requestTitle(request)}}</q-item-label><q-item-label caption>{{requestState(request.state)}} · {{clientName(clientFor(request))}}</q-item-label></q-item-section></q-item></q-list>
            <q-expansion-item :label="t('Central audit details')" class="q-mt-md"><q-list separator><q-item v-for="event in history" :key="event.request_id+event.state"><q-item-section><q-item-label>{{requestTitle(event)}} · {{requestState(event.state)}}</q-item-label><q-item-label caption>{{event.created}}</q-item-label></q-item-section></q-item></q-list></q-expansion-item>
          </q-tab-panel>
          <q-tab-panel name="operations">
            <p>{{t('SSH access may separately request authorization in 1Password.')}}</p>
            <q-select v-model="action" :options="actions.map(value=>({label:t(actionLabels[value]),value}))" emit-value map-options outlined :label="t('Action')" @update:model-value="loadTargets"/>
            <q-select v-model="target" :options="targets" emit-value map-options outlined :label="t('Target')" class="q-my-md"/>
            <q-btn no-caps color="primary" :disable="!target" :loading="busy" :label="t('Prepare operation')" @click="plan"/><q-btn no-caps v-if="canSubmit" outline class="q-ml-sm" :disable="busy" :label="t('Request execution review')" @click="submit"/><q-btn no-caps v-if="operation" flat :disable="busy" :label="t('Check operation status')" @click="status"/>
            <q-expansion-item v-if="result" :label="t('Operation details')" class="q-mt-md"><pre class="mcp-details">{{JSON.stringify(result,null,2)}}</pre></q-expansion-item>
          </q-tab-panel>
        </q-tab-panels>
      </q-card>
      <p class="mcp-background-note">{{t('Closing the window keeps MCP running. Quit i7y to stop it.')}}</p>
    </template>
  </q-page>
</template>
<style scoped>
.mcp-service{display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-bottom:16px}.mcp-service p{margin:0;flex:1;min-width:220px;color:var(--i7y-muted);font-size:13px;line-height:21px}.mcp-panel{overflow:hidden}.mcp-request-list{display:grid;gap:16px;max-width:880px}.mcp-empty{padding:36px 16px;text-align:center}.mcp-empty h2{font-size:20px;font-weight:600;line-height:28px;margin:16px 0 8px}.mcp-empty p,.mcp-background-note{font-size:13px;color:var(--i7y-muted);line-height:21px}.mcp-background-note{margin-top:16px}.mcp-details{white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto;font-size:12px;padding:16px}
</style>
