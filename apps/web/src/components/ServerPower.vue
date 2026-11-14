<script setup lang="ts">
import {computed,onUnmounted,ref,watch} from 'vue'
import {useQuasar} from 'quasar'
import {invoke} from '@tauri-apps/api/core'
import {listen,type UnlistenFn} from '@tauri-apps/api/event'
import {activeOrganization,activeConnectionId,connectionRevision} from '../api'
import {desktopRuntime} from '../desktop-backend'
import {captureServerPowerSource,createServerPowerApi,powerProgressMatches,type PowerNativeContext,type ServerPowerSource} from '../server-power-api'
import {t,locale} from '../i18n'
import {managementHash} from '../routes'
import {credentialReference,credentialManagerLabel} from '../vault-reference'
import {selectPowerResult,presentPowerResult} from '../server-power-presentation'
const props=defineProps<{serverId:string}>()
const q=useQuasar(),data=ref<any>(null),loaded=ref<{server:string;source:string}|null>(null),error=ref(''),busy=ref(false),saving=ref(false),loading=ref(false),stage=ref(''),request=ref(''),configurationError=ref('')
interface LocalSettings {supported:boolean;identity_file:string;proxy_available:boolean;context?:PowerNativeContext}
const local=ref<LocalSettings>({supported:false,identity_file:'',proxy_available:false}),identity=ref(''),viaHost=ref(false),showSettings=ref(false)
const currentHash=()=>window.location.hash
const referenceLabel=(value:any)=>{
  if(!value)return t('vault.notLinked')
  try{
    const reference=credentialReference(value)
    return reference.item?[credentialManagerLabel(reference),reference.account,reference.item].filter(Boolean).join(' / '):t('vault.notLinked')
  }catch{return t('vault.invalidReference')}
}
const source=computed(()=>{connectionRevision.value;activeConnectionId.value;activeOrganization.value;try{return captureServerPowerSource()}catch{return null}})
const sourceIdentity=computed(()=>source.value?JSON.stringify(source.value.identity):'')
let generation=0,timer:ReturnType<typeof setInterval>|undefined,refreshing=false,unlisten:UnlistenFn|undefined,dialog:{hide:()=>unknown}|undefined
let operationContext:PowerNativeContext|undefined
const jobs=computed(()=>data.value?.jobs||[]),blockingJob=computed(()=>jobs.value.find((j:any)=>['running','unknown'].includes(j.status))),blocked=computed(()=>!!blockingJob.value),displayed=computed(()=>selectPowerResult(jobs.value))
const remoteUnlockConfigured=computed(()=>!!data.value?.profile?.boot_host_key&&!!data.value?.profile?.luks_uuid)
const resultPresentation=computed(()=>displayed.value?presentPowerResult(displayed.value,remoteUnlockConfigured.value):null)
const consoleHref=computed(()=>data.value?.profile?'https://my.snel.com/clientarea/services/cloudvps/'+encodeURIComponent(data.value.profile.service_id)+'/':null)
const date=(value:string)=>value?new Date(value.replace(' ','T')).toLocaleString(locale.value):'—'
function failure(cause:any){const reason=typeof cause==='string'?cause:cause?.message;return typeof reason==='string'&&/^[a-z_]+$/.test(reason)?t('power.error.'+reason):cause?.response?.message||t('power.failed')}
async function refresh(initial=false){
  const selected=source.value,server=props.serverId
  if(refreshing||!server||!selected)return false
  const current=generation;refreshing=true
  if(initial)loading.value=true
  try{
    const next=await createServerPowerApi(selected).get(server)
    const settings=desktopRuntime?await invoke<LocalSettings>('server_power_local_settings',{expectedSource:selected.nativeSource}):null
    if(current!==generation||!selected.current())return false
    data.value=next;loaded.value={server,source:JSON.stringify(selected.identity)};error.value=''
    if(settings){local.value=settings;if(initial)identity.value=settings.identity_file}
    return true
  }
  catch(cause:any){if(current===generation)error.value=cause?.status===404?t('power.backendUnavailable'):failure(cause);return false}
  finally{if(current===generation){loading.value=false;refreshing=false}}
}
watch(()=>[props.serverId,sourceIdentity.value],async()=>{
  ++generation;dialog?.hide();dialog=undefined;data.value=null;loaded.value=null;error.value='';configurationError.value='';busy.value=false;saving.value=false;loading.value=false;stage.value='';request.value='';refreshing=false;showSettings.value=false;operationContext=undefined
  local.value={supported:false,identity_file:'',proxy_available:false};identity.value='';viaHost.value=false
  if(timer)clearInterval(timer);if(unlisten){unlisten();unlisten=undefined}
  const current=generation,selected=source.value
  if(!selected)return
  if(desktopRuntime){
    const stop=await listen<{server_id:string;request_id:string;stage:string;context:PowerNativeContext}>('server-power-progress',event=>{if(current===generation&&selected.current()&&powerProgressMatches(operationContext,props.serverId,request.value,event.payload))stage.value=event.payload.stage})
    if(current===generation)unlisten=stop;else stop()
  }
  if(current!==generation)return
  await refresh(true)
  if(current===generation)timer=setInterval(()=>{if(!busy.value)void refresh()},5000)
},{immediate:true})
onUnmounted(()=>{++generation;dialog?.hide();if(timer)clearInterval(timer);unlisten?.()})
interface Execution {generation:number;source:ServerPowerSource;server:string;version:number;context:PowerNativeContext;identityFile:string;viaAutomationHost:boolean}
function execution():Execution|null {
  const selected=source.value
  if(!selected?.current()||loaded.value?.server!==props.serverId||loaded.value?.source!==JSON.stringify(selected.identity)||!local.value.context||!data.value?.profile||!data.value.configuration_current||!data.value.can_edit)return null
  return {generation,source:selected,server:props.serverId,version:data.value.profile.version,context:JSON.parse(JSON.stringify(local.value.context)),identityFile:identity.value,viaAutomationHost:viaHost.value}
}
async function execute(action:'inspect'|'start'|'shutdown',expected=execution()){
  if(!expected||expected.generation!==generation||expected.server!==props.serverId||!expected.source.current()||busy.value||saving.value||action!=='inspect'&&blocked.value)return
  const current=expected.generation
  busy.value=true;error.value='';stage.value='checking_provider';request.value=crypto.randomUUID();operationContext=expected.context
  try{await invoke('server_power_run',{organization:expected.source.identity.organization,serverId:expected.server,action,requestId:request.value,version:expected.version,identityFile:expected.identityFile,viaAutomationHost:expected.viaAutomationHost,opAccount:'',expectedContext:expected.context});if(current===generation&&expected.source.current())await refresh()}
  catch(cause){if(current===generation&&expected.source.current()){const message=failure(cause);await refresh();if(current===generation)error.value=message}}
  finally{if(current===generation){busy.value=false;stage.value='';operationContext=undefined}}
}
function confirm(action:'start'|'shutdown'){
  const expected=execution()
  if(!expected)return
  dialog=q.dialog({title:t(action==='start'?'power.start':'power.stop'),message:t(action==='start'?'power.confirmStart':'power.confirmStop')+' '+(data.value?.name||expected.server)+' ('+(data.value?.address||'')+')',cancel:true,persistent:true,ok:{label:t('Confirm'),color:action==='shutdown'?'negative':'primary'}}).onOk(()=>{dialog=undefined;if(expected.generation===generation&&expected.source.current())void execute(action,expected)})
}
async function importConfiguration(){
  const current=generation,selected=source.value,server=props.serverId,context=local.value.context
  if(!desktopRuntime||!context||!data.value?.can_configure||!selected?.current()||loaded.value?.server!==server||loaded.value?.source!==JSON.stringify(selected.identity)||busy.value||blocked.value||saving.value)return
  saving.value=true;error.value='';configurationError.value=''
  try{
    await invoke('server_power_import_configuration',{serverId:server,expectedContext:JSON.parse(JSON.stringify(context))})
    if(current===generation&&selected.current()&&await refresh(true)&&current===generation&&selected.current()){showSettings.value=false;q.notify({type:'positive',message:t('power.configurationLoaded')})}
  }catch(cause){if(current===generation&&selected.current())configurationError.value=failure(cause)}
  finally{if(current===generation)saving.value=false}
}
function reconcile(job:any){const current=generation,selected=source.value,server=props.serverId,jobId=job.id;if(!selected?.current()||loaded.value?.server!==server||loaded.value?.source!==JSON.stringify(selected.identity))return;dialog=q.dialog({title:t('power.reconcile'),message:t('power.reconcileHelp'),cancel:true,persistent:true}).onOk(async()=>{dialog=undefined;if(current!==generation||!selected.current())return;busy.value=true;try{await createServerPowerApi(selected).reconcile(server,jobId);if(current===generation&&selected.current())await refresh()}catch(cause){if(current===generation)error.value=failure(cause)}finally{if(current===generation)busy.value=false}})}
</script>
<template>
  <q-card v-if="!data||data.provider_supported" flat bordered class="server-power q-mb-md">
    <q-card-section class="power-heading"><h2>{{t('power.title')}}</h2><q-btn v-if="data?.can_configure" flat round dense icon="settings" :aria-label="t('power.settings')" :aria-expanded="showSettings" @click="showSettings=!showSettings"/></q-card-section>
    <q-card-section v-if="error||configurationError" class="q-pt-none"><q-banner rounded class="bg-red-1 text-negative" role="alert">{{error||configurationError}}</q-banner></q-card-section>
    <q-card-section v-if="data" class="q-pt-none">
      <q-banner v-if="!desktopRuntime||!local.supported" rounded class="q-mb-md">{{t('power.desktopRequired')}}</q-banner>
      <p v-if="!data.configuration_current" class="text-grey-7">{{t('power.notConfigured')}}</p>
      <q-btn v-if="!data.configuration_current&&data.can_configure&&!showSettings" flat no-caps icon="key" :label="t('power.loadConfiguration')" class="q-mb-md" :loading="saving" :disable="busy||blocked" @click="data.configuration?importConfiguration():showSettings=true"/>
      <div class="row q-gutter-sm items-center">
        <q-btn unelevated no-caps color="primary" icon="power_settings_new" :label="t('power.start')" :disable="!local.supported||!data.configuration_current||!data.can_edit||busy||saving||blocked" @click="confirm('start')"/>
        <q-btn outline no-caps color="negative" icon="power_settings_new" :label="t('power.stop')" :disable="!local.supported||!data.configuration_current||!data.can_edit||busy||saving||blocked" @click="confirm('shutdown')"/>
        <q-btn flat no-caps icon="refresh" :label="t('power.inspect')" :disable="!local.supported||!data.configuration_current||!data.can_edit||busy||saving" @click="execute('inspect')"/>
        <q-btn v-if="consoleHref&&(!resultPresentation?.console||busy)" flat no-caps icon="open_in_new" :label="t('power.console')" :href="consoleHref" target="_blank" rel="noopener noreferrer"/>
      </div>
      <p v-if="busy" role="status" aria-live="polite" class="q-mt-md q-mb-none"><q-spinner class="q-mr-sm" color="primary"/>{{t('power.stage.'+stage)}}</p>
      <div v-else-if="displayed&&resultPresentation" class="power-result q-mt-md" :class="'power-result--'+resultPresentation.tone" role="status" aria-live="polite">
        <q-icon :name="resultPresentation.icon" :color="resultPresentation.tone" size="24px" class="power-result-icon"/>
        <div class="power-result-content"><strong>{{t(resultPresentation.title)}}</strong><p v-if="resultPresentation.detail">{{t(resultPresentation.detail)}}</p><span class="power-result-time">{{t('power.lastChecked')}} {{date(displayed.updated||'')}}</span></div>
        <div v-if="resultPresentation.console&&consoleHref||displayed.status==='unknown'&&data.can_configure" class="power-result-actions">
          <q-btn v-if="resultPresentation.console&&consoleHref" unelevated no-caps color="primary" icon="open_in_new" :label="t('power.openConsole')" :href="consoleHref" target="_blank" rel="noopener noreferrer"/>
          <q-btn v-if="displayed.status==='unknown'&&data.can_configure" flat no-caps :label="t('power.reconcile')" @click="reconcile(displayed)"/>
        </div>
      </div>
    </q-card-section>
    <q-card-section v-if="showSettings&&data?.can_configure" class="q-pt-none">
      <div class="power-settings">
        <h3 class="power-wide">{{t('power.settings')}}</h3>
        <div class="power-wide"><p>{{t('power.inventoryHelp')}}</p></div>
        <div><strong>{{t('vault.serverItem')}}</strong><p>{{referenceLabel(data.credentials?.server)}}</p><q-btn flat no-caps :href="managementHash('servers','edit',serverId,null,currentHash())" :label="t('vault.editServer')" :disable="busy||saving||blocked"/></div>
        <div><strong>{{t('vault.workspaceItem')}}</strong><p>{{referenceLabel(data.credentials?.workspace)}}</p><q-btn flat no-caps :href="managementHash('workspaces','edit',data.workspace,null,currentHash())" :label="t('vault.editWorkspace')" :disable="busy||saving||blocked"/></div>
        <p class="power-wide">{{t('power.itemFieldsHelp')}}</p>
        <div v-if="desktopRuntime&&local.supported&&remoteUnlockConfigured" class="power-wide"><q-input v-model="identity" outlined dense :disable="busy" :label="t('SSH identity file')"/><q-checkbox v-if="local.proxy_available" v-model="viaHost" :disable="busy" :label="t('power.viaHost')"/></div>
        <div class="row justify-end power-wide"><q-btn unelevated color="primary" no-caps icon="sync" :label="t('power.loadConfiguration')" :loading="saving" :disable="!local.supported||!data.configuration||busy||blocked" @click="importConfiguration"/></div>
      </div>
    </q-card-section>
    <q-inner-loading :showing="loading"><q-spinner color="primary"/></q-inner-loading>
  </q-card>
</template>
<style scoped>
.power-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.power-heading h2{font-size:16px;font-weight:600;line-height:24px;margin:0}.power-settings{display:grid;grid-template-columns:1fr 1fr;gap:16px;border-top:1px solid var(--i7y-border,#e4e4e7);padding-top:16px}.power-settings h3{font-size:14px;font-weight:600;margin:0}.power-wide{grid-column:1/-1}.power-settings p{font-size:13px;margin:0;color:var(--i7y-muted,#71717a)}.power-result{display:flex;align-items:flex-start;gap:12px;padding:16px;border-radius:10px;border-left:3px solid var(--q-primary);background:color-mix(in srgb,var(--q-primary) 5%,transparent)}.power-result--positive{border-color:var(--q-positive);background:color-mix(in srgb,var(--q-positive) 7%,transparent)}.power-result--warning{border-color:var(--q-warning);background:color-mix(in srgb,var(--q-warning) 8%,transparent)}.power-result--negative{border-color:var(--q-negative);background:color-mix(in srgb,var(--q-negative) 6%,transparent)}.power-result-content{flex:1;min-width:0}.power-result-content strong{display:block;font-weight:600;line-height:24px}.power-result-content p{font-size:13px;line-height:20px;max-width:75ch;margin:4px 0 8px}.power-result-time{font-size:12px;color:var(--i7y-muted,#71717a)}.power-result-actions{display:flex;flex-wrap:wrap;gap:8px}.power-result-icon{margin-top:1px}@media(max-width:599px){.power-settings{grid-template-columns:1fr}.power-result{flex-wrap:wrap}.power-result-actions{width:100%;padding-left:36px}}
</style>
