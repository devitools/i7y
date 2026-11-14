<script setup lang="ts">
import {computed,onUnmounted,ref,watch} from 'vue'
import {useQuasar} from 'quasar'
import {invoke} from '@tauri-apps/api/core'
import {listen,type UnlistenFn} from '@tauri-apps/api/event'
import {activeOrganization,activeConnectionId,connectionRevision} from '../api'
import {desktopRuntime} from '../desktop-backend'
import {captureServerPowerSource,createServerPowerApi,powerProgressMatches,type PowerNativeContext,type ServerPowerSource} from '../server-power-api'
import {t,locale} from '../i18n'
const props=defineProps<{serverId:string}>()
const q=useQuasar(),data=ref<any>(null),loaded=ref<{server:string;source:string}|null>(null),error=ref(''),busy=ref(false),saving=ref(false),loading=ref(false),stage=ref(''),request=ref(''),formVersion=ref(0)
interface LocalSettings {supported:boolean;identity_file:string;proxy_available:boolean;context?:PowerNativeContext}
const local=ref<LocalSettings>({supported:false,identity_file:'',proxy_available:false}),identity=ref(''),viaHost=ref(false),showSettings=ref(false)
const opAccount=ref(localStorage.getItem('i7y.power.opAccount')||'')
const form=ref({service_id:'',vm_id:'',boot_port:2222,boot_host_key:'',luks_uuid:''})
const source=computed(()=>{connectionRevision.value;activeConnectionId.value;activeOrganization.value;try{return captureServerPowerSource()}catch{return null}})
const sourceIdentity=computed(()=>source.value?JSON.stringify(source.value.identity):'')
let generation=0,timer:ReturnType<typeof setInterval>|undefined,refreshing=false,unlisten:UnlistenFn|undefined,dialog:{hide:()=>unknown}|undefined
let operationContext:PowerNativeContext|undefined
const jobs=computed(()=>data.value?.jobs||[]),latest=computed(()=>jobs.value[0]),blockingJob=computed(()=>jobs.value.find((j:any)=>['running','unknown'].includes(j.status))),blocked=computed(()=>!!blockingJob.value),displayed=computed(()=>blockingJob.value||latest.value)
const consoleHref=computed(()=>data.value?.profile?'https://my.snel.com/clientarea/services/cloudvps/'+encodeURIComponent(data.value.profile.service_id)+'/':null)
const date=(value:string)=>value?new Date(value.replace(' ','T')).toLocaleString(locale.value):'—'
function failure(cause:any){const reason=typeof cause==='string'?cause:cause?.message;return typeof reason==='string'&&/^[a-z_]+$/.test(reason)?t('power.error.'+reason):cause?.response?.message||t('power.failed')}
async function refresh(initial=false){
  const selected=source.value,server=props.serverId
  if(refreshing||!server||!selected)return
  const current=generation;refreshing=true
  if(initial)loading.value=true
  try{
    const next=await createServerPowerApi(selected).get(server)
    const settings=desktopRuntime?await invoke<LocalSettings>('server_power_local_settings',{expectedSource:selected.nativeSource}):null
    if(current!==generation||!selected.current())return
    data.value=next;loaded.value={server,source:JSON.stringify(selected.identity)};error.value=''
    if(settings){local.value=settings;if(initial)identity.value=settings.identity_file}
    if(initial){formVersion.value=next.profile?.version||0;form.value={service_id:next.profile?.service_id||'',vm_id:next.profile?.vm_id||'',boot_port:next.profile?.boot_port||2222,boot_host_key:next.profile?.boot_host_key||'',luks_uuid:next.profile?.luks_uuid||''}}
  }
  catch(cause:any){if(current===generation)error.value=cause?.status===404?t('power.backendUnavailable'):failure(cause)}
  finally{if(current===generation){loading.value=false;refreshing=false}}
}
watch(()=>[props.serverId,sourceIdentity.value],async()=>{
  ++generation;dialog?.hide();dialog=undefined;data.value=null;loaded.value=null;error.value='';busy.value=false;saving.value=false;loading.value=false;stage.value='';request.value='';refreshing=false;formVersion.value=0;showSettings.value=false;operationContext=undefined
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
interface Execution {generation:number;source:ServerPowerSource;server:string;version:number;context:PowerNativeContext;identityFile:string;viaAutomationHost:boolean;opAccount:string}
function execution():Execution|null {
  const selected=source.value
  if(!selected?.current()||loaded.value?.server!==props.serverId||loaded.value?.source!==JSON.stringify(selected.identity)||!local.value.context||!data.value?.profile||!data.value.can_edit)return null
  return {generation,source:selected,server:props.serverId,version:data.value.profile.version,context:JSON.parse(JSON.stringify(local.value.context)),identityFile:identity.value,viaAutomationHost:viaHost.value,opAccount:opAccount.value.trim()}
}
async function execute(action:'inspect'|'start'|'shutdown',expected=execution()){
  if(!expected||expected.generation!==generation||expected.server!==props.serverId||!expected.source.current()||busy.value||action!=='inspect'&&blocked.value)return
  const current=expected.generation
  busy.value=true;error.value='';stage.value='checking_provider';request.value=crypto.randomUUID();operationContext=expected.context
  try{localStorage.setItem('i7y.power.opAccount',expected.opAccount);await invoke('server_power_run',{organization:expected.source.identity.organization,serverId:expected.server,action,requestId:request.value,version:expected.version,identityFile:expected.identityFile,viaAutomationHost:expected.viaAutomationHost,opAccount:expected.opAccount,expectedContext:expected.context});if(current===generation&&expected.source.current())await refresh()}
  catch(cause){if(current===generation&&expected.source.current()){const message=failure(cause);await refresh();if(current===generation)error.value=message}}
  finally{if(current===generation){busy.value=false;stage.value='';operationContext=undefined}}
}
function confirm(action:'start'|'shutdown'){
  const expected=execution()
  if(!expected)return
  dialog=q.dialog({title:t(action==='start'?'power.start':'power.stop'),message:t(action==='start'?'power.confirmStart':'power.confirmStop')+' '+(data.value?.name||expected.server)+' ('+(data.value?.address||'')+')',cancel:true,persistent:true,ok:{label:t('Confirm'),color:action==='shutdown'?'negative':'primary'}}).onOk(()=>{dialog=undefined;if(expected.generation===generation&&expected.source.current())void execute(action,expected)})
}
async function save(){const current=generation,selected=source.value,server=props.serverId,body={...form.value,version:formVersion.value};if(!selected?.current()||loaded.value?.server!==server||loaded.value?.source!==JSON.stringify(selected.identity))return;saving.value=true;error.value='';try{await createServerPowerApi(selected).save(server,body);if(current===generation&&selected.current()){await refresh(true);showSettings.value=false}}catch(cause){if(current===generation)error.value=failure(cause)}finally{if(current===generation)saving.value=false}}
function reconcile(job:any){const current=generation,selected=source.value,server=props.serverId,jobId=job.id;if(!selected?.current()||loaded.value?.server!==server||loaded.value?.source!==JSON.stringify(selected.identity))return;dialog=q.dialog({title:t('power.reconcile'),message:t('power.reconcileHelp'),cancel:true,persistent:true}).onOk(async()=>{dialog=undefined;if(current!==generation||!selected.current())return;busy.value=true;try{await createServerPowerApi(selected).reconcile(server,jobId);if(current===generation&&selected.current())await refresh()}catch(cause){if(current===generation)error.value=failure(cause)}finally{if(current===generation)busy.value=false}})}
</script>
<template>
  <q-card v-if="!data||data.provider_supported" flat bordered class="server-power q-mb-md">
    <q-card-section class="power-heading"><div><h2>{{t('power.title')}}</h2><p>{{t('power.help')}}</p></div><q-btn v-if="data?.can_configure" flat round dense icon="settings" :aria-label="t('power.settings')" :aria-expanded="showSettings" @click="showSettings=!showSettings"/></q-card-section>
    <q-card-section v-if="error" class="q-pt-none"><q-banner rounded class="bg-red-1 text-negative" role="alert">{{error}}</q-banner></q-card-section>
    <q-card-section v-if="data" class="q-pt-none">
      <q-banner v-if="!desktopRuntime||!local.supported" rounded class="q-mb-md">{{t('power.desktopRequired')}}</q-banner>
      <p v-if="!data.profile" class="text-grey-7">{{t('power.notConfigured')}}</p>
      <div class="row q-gutter-sm items-center">
        <q-btn unelevated no-caps color="primary" icon="power_settings_new" :label="t('power.start')" :disable="!local.supported||!data.profile||!data.can_edit||busy||blocked" @click="confirm('start')"/>
        <q-btn outline no-caps color="negative" icon="power_settings_new" :label="t('power.stop')" :disable="!local.supported||!data.profile||!data.can_edit||busy||blocked" @click="confirm('shutdown')"/>
        <q-btn flat no-caps icon="refresh" :label="t('power.inspect')" :disable="!local.supported||!data.profile||!data.can_edit||busy" @click="execute('inspect')"/>
        <q-btn v-if="consoleHref" flat no-caps icon="open_in_new" :label="t('power.console')" :href="consoleHref" target="_blank" rel="noopener noreferrer"/>
      </div>
      <p v-if="busy" role="status" aria-live="polite" class="q-mt-md q-mb-none"><q-spinner class="q-mr-sm" color="primary"/>{{t('power.stage.'+stage)}}</p>
      <q-banner v-else-if="displayed" rounded class="q-mt-md" role="status"><strong>{{t('power.stage.'+displayed.stage)}}</strong><span class="q-ml-sm">{{date(displayed.updated)}}</span><p v-if="displayed.reason" class="q-mb-none q-mt-sm">{{t('power.error.'+displayed.reason)}}</p><q-btn v-if="displayed.status==='unknown'&&data.can_configure" flat no-caps class="q-mt-sm" :label="t('power.reconcile')" @click="reconcile(displayed)"/></q-banner>
      <q-expansion-item v-if="desktopRuntime&&local.supported&&data.profile" dense :label="t('power.unlockOptions')" class="q-mt-md"><div class="q-pa-md"><q-input v-model="opAccount" outlined dense :disable="busy" :label="t('power.opAccount')" class="q-mb-md"/><q-input v-if="data.profile.boot_host_key" v-model="identity" outlined dense :disable="busy" :label="t('SSH identity file')"/><q-checkbox v-if="data.profile.boot_host_key&&local.proxy_available" v-model="viaHost" :disable="busy" :label="t('power.viaHost')"/></div></q-expansion-item>
    </q-card-section>
    <q-card-section v-if="showSettings&&data?.can_configure" class="q-pt-none">
      <q-form @submit="save" class="power-settings">
        <q-input v-model="form.service_id" outlined dense :label="t('power.serviceId')" :disable="busy||blocked" :rules="[v=>/^[1-9][0-9]{0,15}$/.test(v)||t('power.required')]"/>
        <q-input v-model="form.vm_id" outlined dense :label="t('power.vmId')" :disable="busy||blocked" :rules="[v=>/^[1-9][0-9]{0,15}$/.test(v)||t('power.required')]"/>
        <p class="power-wide">{{t('power.bootHelp')}}</p>
        <q-input v-model.number="form.boot_port" outlined dense type="number" min="1" max="65535" :label="t('power.bootPort')" :disable="busy||blocked"/>
        <q-input v-model="form.luks_uuid" outlined dense :label="t('power.luksId')" :disable="busy||blocked"/>
        <q-input v-model="form.boot_host_key" outlined dense type="textarea" autogrow :label="t('power.bootKey')" class="power-wide" :disable="busy||blocked"/>
        <div class="row justify-end power-wide"><q-btn type="submit" unelevated color="primary" no-caps :label="t('Save')" :loading="saving" :disable="busy||blocked"/></div>
      </q-form>
    </q-card-section>
    <q-inner-loading :showing="loading"><q-spinner color="primary"/></q-inner-loading>
  </q-card>
</template>
<style scoped>
.power-heading{display:flex;justify-content:space-between;gap:16px}.power-heading h2{font-size:16px;font-weight:600;line-height:24px;margin:0}.power-heading p{margin:6px 0 0;color:var(--i7y-muted,#71717a);font-size:13px}.power-settings{display:grid;grid-template-columns:1fr 1fr;gap:16px}.power-wide{grid-column:1/-1}.power-settings p{font-size:13px;margin:0;color:var(--i7y-muted,#71717a)}@media(max-width:599px){.power-settings{grid-template-columns:1fr}}
</style>
