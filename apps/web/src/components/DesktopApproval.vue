<script setup lang="ts">
import {onMounted,onUnmounted,ref,nextTick,computed,watch} from 'vue'
import {invoke} from '@tauri-apps/api/core'
import {t,locale,languageOptions} from '../i18n'
import {dark} from '../theme'
import {approvalError,clientName,backendName,requestTitle,reviewParameters} from '../mcp-presentation'
import {actionSummary,actionDetails} from '../mcp-action-summary'
const detail=ref<any>(null),busy=ref(false),error=ref(''),showDetails=ref(false),showTechnical=ref(false)
const reading=computed(()=>detail.value?.request?.tool==='authorize_connection')
const summary=computed(()=>actionSummary(detail.value?.request || {}))
const fields=computed(()=>actionDetails(detail.value?.request || {}))
const purpose=computed(()=>t(reading.value?'Allow {client} to query your inventory for 5 minutes.':'{client} requests this change.').replace('{client}',clientName(detail.value?.client)))
watch([()=>detail.value?.request?.id,()=>showDetails.value,()=>showTechnical.value],()=>{
  if(detail.value?.request?.id)void invoke('mcp_approval_layout',{requestId:detail.value.request.id,expanded:showDetails.value,technical:showTechnical.value}).catch(()=>{})
})
const authorizationLabel=computed(()=>t(detail.value?.authorization_provider==='macos_local_authentication'?'Authorize with Touch ID':'Authorize with system authentication'))
let timer:ReturnType<typeof setInterval>|undefined
let refreshing=false
const started=new Set<string>()
async function refresh(){
  if(refreshing)return
  refreshing=true
  try{
    const saved=localStorage.getItem('i7y.locale')
    if(languageOptions.some(option=>option.value===saved))locale.value=saved
    dark.value=localStorage.getItem('i7y.dark')==='true'
    const next=await invoke<any>('mcp_approval_current')
    if(next?.request?.id!==detail.value?.request?.id){error.value='';showDetails.value=false;showTechnical.value=false}
    detail.value=next
    if(next?.request?.tool==='authorize_connection'&&!started.has(next.request.id)){
      started.add(next.request.id)
      await nextTick()
      void decide(next.request.id,true)
    }
  }catch{detail.value=null}finally{refreshing=false}
}
async function decide(id:string,approve:boolean){
  if(busy.value&&approve)return
  busy.value=true;error.value=''
  try{await invoke('mcp_approval_decide',{requestId:id,approve});await refresh()}catch(cause){error.value=approvalError(cause)}finally{busy.value=false}
}
function cancelOnEscape(event:KeyboardEvent){if(event.key==='Escape'&&detail.value){event.preventDefault();void decide(detail.value.request.id,false)}}
onMounted(()=>{window.addEventListener('keydown',cancelOnEscape);void refresh();timer=setInterval(refresh,500)})
onUnmounted(()=>{clearInterval(timer);window.removeEventListener('keydown',cancelOnEscape)})
</script>
<template>
  <main class="approval-window" :class="{'approval-dark':dark}">
    <h1 data-tauri-drag-region>{{t('i7y access request')}}</h1>
    <div v-if="detail" class="approval-content">
      <q-banner v-if="error" rounded class="bg-negative text-white" role="alert">{{error}}</q-banner>
      <div class="approval-identities" aria-hidden="true"><span class="client-icon"><q-icon name="computer" size="32px"/></span><span class="identity-connection"><q-icon name="arrow_forward" size="18px"/></span><span class="app-icon"><q-icon name="hub" size="36px"/></span></div>
      <p class="approval-purpose">{{purpose}}</p>
      <section v-if="!reading" class="action-summary" :aria-label="t('Change summary')">
        <h2>{{requestTitle(detail.request)}}</h2>
        <dl><div v-for="row in summary" :key="row.label"><dt>{{t(row.label)}}</dt><dd>{{row.label==='Severity'?t('alerts.severity.'+row.value):row.label==='Action'?t(row.value):row.value}}</dd></div></dl>
      </section>
      <section class="approval-panel">
        <button type="button" class="organization-toggle" :aria-expanded="showDetails" aria-controls="approval-details" @click="showDetails=!showDetails">
          <q-icon :name="showDetails?'expand_more':'chevron_right'" size="20px"/><q-icon name="corporate_fare" size="24px"/><strong>{{detail.organization_name || t('Selected organization')}}</strong>
        </button>
        <div v-if="showDetails" id="approval-details" class="authorization-details">
          <h2>{{t(reading?'Authorization details':'Change details')}}</h2>
          <p>{{t(reading?'Read inventory, telemetry, alerts and incidents for 5 minutes, until disconnection or device lock. Changes require separate approval.':'Review this change before authorizing it. This approval applies only to the action and target shown here.')}}</p>
          <dl class="detail-context"><div><dt>{{t('Backend')}}</dt><dd>{{backendName(detail.request.context?.backend)}}</dd></div><div><dt>{{t('Signed in as')}}</dt><dd>{{detail.user?.email || detail.user?.name}}</dd></div></dl>
          <dl v-if="!reading" class="parameter-list"><div v-for="(row,index) in fields" :key="index"><dt>{{row.labels.map(label=>t(label)).join(' / ')}}</dt><dd>{{row.labels.at(-1)==='Severity'?t('alerts.severity.'+row.value):row.value}}</dd></div></dl>
          <q-expansion-item dense :label="t('Technical details')" class="technical-details" v-model="showTechnical"><pre>{{JSON.stringify({client:detail.client,request_id:detail.request.id,backend:detail.request.context.backend,parameters:reading?undefined:reviewParameters(detail.request)},null,2)}}</pre></q-expansion-item>
        </div>
      </section>
      <p class="client-note">{{t('Client name reported by the agent.')}}</p>
    </div>
    <p v-else class="approval-empty">{{t('This request is no longer waiting for approval.')}}</p>
    <footer v-if="detail">
      <q-btn no-caps outline dense class="cancel-button" :label="t('Cancel')" @click="decide(detail.request.id,false)"/>
      <template v-if="busy"><span class="touch-caption" role="status">{{authorizationLabel}}</span><span class="native-auth-space" aria-hidden="true"/></template>
      <q-btn v-else-if="reading" no-caps flat color="primary" class="authorize-button" :label="t('Try again')" @click="decide(detail.request.id,true)"/>
      <q-btn v-else no-caps color="primary" icon="fingerprint" class="authorize-button" :label="authorizationLabel" @click="decide(detail.request.id,true)"/>
    </footer>
  </main>
</template>
<style scoped>
.approval-window{--approval-bg:#f5f5f8;--approval-panel:#fff;--approval-border:#d8d8e0;--approval-text:#24242b;--approval-muted:#676774;display:flex;flex-direction:column;height:100vh;overflow:hidden;padding:24px 24px 18px;background:var(--approval-bg);color:var(--approval-text);gap:14px}
.approval-dark{--approval-bg:#303034;--approval-panel:#222225;--approval-border:#4b4b52;--approval-text:#f5f5f7;--approval-muted:#bdbdc7;color-scheme:dark}
h1{flex:none;font-size:20px;line-height:26px;letter-spacing:-.4px;font-weight:650;text-align:center;margin:0}
.approval-content{display:flex;flex-direction:column;gap:14px;min-height:0;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--approval-border) transparent;flex:1}
.approval-content::-webkit-scrollbar{width:4px}.approval-content::-webkit-scrollbar-thumb{background:var(--approval-border);border-radius:4px}
.approval-identities{display:flex;align-items:center;justify-content:center;margin:3px 0 0;flex:none}
.client-icon,.app-icon{display:flex;width:50px;height:50px;align-items:center;justify-content:center;border-radius:14px;background:var(--approval-panel);color:var(--approval-text)}.client-icon{border:1px solid var(--approval-border)}
.app-icon{background:#4f46e5;color:white;box-shadow:inset 0 0 0 1px #ffffff26}.identity-connection{width:66px;display:flex;align-items:center;justify-content:center;color:var(--approval-muted)}.identity-connection::before,.identity-connection::after{content:'';width:18px;height:1px;background:var(--approval-border)}
.approval-purpose{font-size:14px;line-height:20px;text-align:center;font-weight:500;margin:0;overflow-wrap:anywhere}
.action-summary{flex:none}.action-summary h2{font-size:16px;line-height:22px;font-weight:600;margin:0 0 6px}.action-summary dl{display:grid;gap:4px;margin:0}.action-summary dl>div{display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px;font-size:13px;line-height:18px}.action-summary dt{color:var(--approval-muted)}.action-summary dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.approval-panel{flex:none;min-width:0;background:var(--approval-panel);border:1px solid var(--approval-border);border-radius:8px;overflow:hidden}
.organization-toggle{display:flex;align-items:center;gap:10px;width:100%;min-height:62px;padding:14px 12px;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}.organization-toggle strong{font-size:14px;line-height:20px;overflow-wrap:anywhere}.organization-toggle:focus-visible{outline:2px solid #918aff;outline-offset:-3px;border-radius:7px}
.authorization-details{padding:0 14px 10px;font-size:13px;line-height:19px}.authorization-details h2{font-size:14px;line-height:20px;font-weight:600;margin:2px 0 12px}.authorization-details p{margin:0 0 12px}.detail-context,.parameter-list{display:grid;gap:10px;margin:0 0 12px}.detail-context>div{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px}.detail-context dt,.parameter-list dt{color:var(--approval-muted);font-size:12px}.detail-context dd,.parameter-list dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.parameter-list{padding-top:12px;border-top:1px solid var(--approval-border)}.technical-details{margin:0 -8px}.technical-details :deep(.q-item){padding:4px 8px;min-height:28px;font-size:12px;color:var(--approval-muted)}.technical-details pre{padding:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:16px;max-height:180px;overflow:auto;margin:0}
.client-note,.approval-empty{font-size:11px;line-height:16px;color:var(--approval-muted);margin:0}
footer{display:flex;align-items:center;gap:8px;min-height:52px;flex:none}.cancel-button{padding:0 10px;min-height:28px;font-size:12px;border-radius:6px;background:#ffffff08}.cancel-button:before{border-color:var(--approval-border)}.authorize-button,.touch-caption{margin-left:auto}.authorize-button{font-size:12px;border-radius:8px}.touch-caption{font-size:14px;line-height:19px;font-weight:600;text-align:right}.native-auth-space{width:52px;height:52px;flex:none}
</style>
