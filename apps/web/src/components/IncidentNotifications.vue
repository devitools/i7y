<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { alertsApi } from '../alerts-api'
import { authStore } from '../api'
import { t } from '../i18n'
import { createDesktopIncidentSync } from '../desktop-incidents'
import { createIncidentNoticeDisplay } from '../incident-notices'
const props = defineProps<{authenticated:boolean, organization:string|null}>()
const q = useQuasar(), count = ref(0), unavailable = ref(false)
const cursors = new Map<string,string>()
const desktopIncidents = createDesktopIncidentSync()
const notices = createIncidentNoticeDisplay({show:(notice,presentation,onDismiss)=>{
  const key=context()
  return q.notify({message:notice.title,caption:t(presentation.caption),icon:presentation.icon,iconColor:presentation.color,classes:'incident-toast',multiLine:true,group:false,timeout:7000,position:'top-right',actions:[{label:t(notice.kind==='summary'?'incidents.title':'incidents.view'),noCaps:true,handler:()=>{if(key===context())window.location.hash=notice.incident_id?'#/incidents/'+encodeURIComponent(notice.incident_id):'#/incidents'}}],onDismiss})
}})
let generation = 0, running = false, timer: ReturnType<typeof setInterval>, identity = ''
const label = computed(() => t(unavailable.value?'incidents.notificationsUnavailable':'incidents.notifications') + (count.value ? ': '+count.value : ''))
function context() {return props.authenticated && props.organization && authStore.isValid ? authStore.record?.id+':'+props.organization : ''}
function reset() {
  generation++;running=false;count.value=0;unavailable.value=false
  notices.reset()
  const user=authStore.record?.id || ''
  if (identity!==user || !props.authenticated) {cursors.clear();identity=user}
  desktopIncidents.setContext(context())
  poll()
}
async function poll() {
  const key=context(),version=generation
  if(!key || running)return
  running=true
  try {
    const result=await alertsApi.notifications(cursors.get(key)||'0')
    if(version!==generation || key!==context())return
    unavailable.value=false;count.value=result.open_count
    desktopIncidents.update(key,result)
    const initial=!cursors.has(key)
    const fresh=[]
    let cursor=cursors.get(key)||'0'
    for (const notice of result.items || []) {
      if(BigInt(notice.sequence)<=BigInt(cursor))continue
      fresh.push(notice)
      cursor=String(notice.sequence)
    }
    notices.presentBatch(fresh,initial,result.open_count,t('incidents.startupSummary').replace('{count}',String(result.open_count)))
    cursors.set(key,String(result.cursor || cursor))
  } catch {if(version===generation)unavailable.value=true}
  finally {if(version===generation)running=false}
}
watch(()=>[props.authenticated,props.organization],reset,{immediate:true})
const unsubscribe=authStore.onChange(()=>reset())
onMounted(()=>{timer=setInterval(poll,10000)})
onUnmounted(()=>{generation++;clearInterval(timer);unsubscribe();desktopIncidents.dispose();notices.clear()})
</script>
<template><slot :visible="!!authenticated && !!organization" :count="count" :unavailable="unavailable" :label="label" /></template>
