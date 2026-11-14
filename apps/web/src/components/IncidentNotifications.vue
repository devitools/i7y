<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { connectionRevision, authStore, connectedSources, refreshConnectedOrganizations } from '../api'
import { t } from '../i18n'
import { createDesktopIncidentSync } from '../desktop-incidents'
import { createIncidentNoticeDisplay } from '../incident-notices'
import { createIncidentNotificationInbox, incidentHref, sourceFingerprint } from '../incident-inbox'
import { incidentSources } from '../incident-sources'
defineProps<{authenticated:boolean, organization:string|null}>()
const q=useQuasar(),count=ref(0),unavailable=ref(false)
const inbox=createIncidentNotificationInbox(),desktopIncidents=createDesktopIncidentSync()
const sources=computed(()=>{connectionRevision.value;return incidentSources()})
const visible=computed(()=>sources.value.length>0)
const label=computed(()=>t(unavailable.value?'incidents.notificationsUnavailable':'incidents.notifications')+(count.value?': '+count.value:''))
const notices=createIncidentNoticeDisplay({show:(notice:any,presentation,onDismiss)=>q.notify({message:notice.title,caption:[notice.connection_name,notice.organization_name,t(presentation.caption)].filter(Boolean).join(' · '),icon:presentation.icon,iconColor:presentation.color,classes:'incident-toast',multiLine:true,group:false,timeout:7000,position:'top-right',actions:[{label:t(notice.kind==='summary'?'incidents.title':'incidents.view'),noCaps:true,handler:()=>{if(notice.kind==='summary')window.location.hash='#/incidents';else if(connectedSources().some(source=>source.id===notice.connection_id && source.generation===notice.source_generation))window.location.hash=incidentHref({...notice,incident_id:notice.original_incident_id})}}],onDismiss})})
let generation=0,running=false,timer:ReturnType<typeof setInterval>,sequence=0,organizationPoll=0
const nativeContext='incident-center'
desktopIncidents.setContext(nativeContext)
async function poll() {
  if(running)return
  const version=generation,snapshot=sources.value
  running=true
  try {
    const result=await inbox.poll(snapshot,{deferCommit:true})
    if(version!==generation)return
    result.commit()
    count.value=result.open_count;unavailable.value=result.failures.length>0
    if(result.initialCount)notices.presentBatch([],true,result.initialCount,t('incidents.startupSummary').replace('{count}',String(result.open_count)))
    const items=result.items.map(notice=>({...notice,original_incident_id:notice.incident_id,incident_id:notice.notice_key,sequence:++sequence}))
    notices.presentBatch(items,false,result.open_count,'')
    desktopIncidents.update(nativeContext,{open_count:result.open_count,cursor:String(sequence),items})
  } catch {if(version===generation)unavailable.value=true}
  finally {if(version===generation)running=false}
}
watch(()=>sourceFingerprint(sources.value),()=>{generation++;running=false;notices.clear();if(!sources.value.length){inbox.reset();count.value=0;unavailable.value=false;desktopIncidents.update(nativeContext,{open_count:0,cursor:String(sequence),items:[]})}void poll()},{immediate:true})
const unsubscribe=authStore.onChange(()=>{void poll()})
onMounted(()=>{timer=setInterval(()=>{void poll();if(++organizationPoll%6===0)void refreshConnectedOrganizations().catch(()=>{})},10000)})
onUnmounted(()=>{generation++;clearInterval(timer);unsubscribe();desktopIncidents.dispose();notices.clear()})
</script>
<template><slot :visible="visible" :count="count" :unavailable="unavailable" :label="label" /></template>
