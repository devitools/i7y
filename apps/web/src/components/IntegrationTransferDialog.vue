<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { pb, activeOrganization, organizationChoices, globalAdmin } from '../api'
import { t } from '../i18n'
const props=defineProps<{integration:any}>()
const emit=defineEmits(['close','transferred'])
const source=activeOrganization.value,backend=pb.baseURL
const destination=ref<string|null>(null),plan=ref<any>(null),busy=ref(false),error=ref('')
const choices=computed(()=>organizationChoices.value.filter(org=>org.id!==source && (globalAdmin.value || org.role==='admin')).map(org=>({label:org.name,value:org.id})))
const current=()=>activeOrganization.value===source && pb.baseURL===backend
const destinationName=computed(()=>choices.value.find(org=>org.value===destination.value)?.label||'')
watch(destination,()=>{plan.value=null;error.value=''})
async function preview(){
  if(busy.value || !destination.value || !current())return
  busy.value=true;error.value=''
  try{
    const result=await pb.send(`/api/i7y/alerts/v1/integrations/${props.integration.id}/transfer/preview`,{method:'POST',body:{destination_organization:destination.value},headers:{'X-I7y-Organization':source},requestKey:null})
    if(current())plan.value=result
  }catch(cause){if(current())error.value=cause.response?.message||t('alerts.transferError')}
  finally{busy.value=false}
}
async function transfer(){
  if(busy.value || !plan.value || !current())return
  busy.value=true;error.value=''
  try{
    await pb.send(`/api/i7y/alerts/v1/integrations/${props.integration.id}/transfer`,{method:'POST',body:{destination_organization:destination.value,plan_hash:plan.value.plan_hash},headers:{'X-I7y-Organization':source},requestKey:null})
    if(current())emit('transferred')
    emit('close')
  }catch(cause){if(current()){plan.value=null;error.value=cause.response?.message||t('alerts.transferError')}}
  finally{busy.value=false}
}
</script>
<template>
  <q-dialog :model-value="true" :persistent="busy" @hide="emit('close')">
    <q-card style="width:560px;max-width:calc(100vw - 32px)">
      <q-card-section><h2 class="text-h6 q-ma-none">{{t('alerts.transferIntegration')}}</h2><p>{{integration.name}}</p><p>{{t('alerts.transferHelp')}}</p>
        <q-banner v-if="error" class="error-banner q-mb-md" role="alert">{{error}}</q-banner>
        <q-select v-model="destination" outlined emit-value map-options :disable="busy" :options="choices" :label="t('Destination organization')"/>
        <section v-if="plan" class="q-mt-md"><strong>{{destinationName}}</strong><p>{{t('alerts.transferCounts').replace('{incidents}',String(plan.incident_count)).replace('{events}',String(plan.event_count))}}</p><p v-if="plan.clears_workspace">{{t('alerts.transferWorkspace')}}</p><p>{{t('alerts.transferIdentity')}}</p></section>
      </q-card-section>
      <q-card-actions align="right" class="q-pa-md"><q-btn flat no-caps :disable="busy" :label="t('Cancel')" @click="emit('close')"/><q-btn v-if="!plan" unelevated no-caps color="primary" :disable="!destination" :loading="busy" :label="t('alerts.transferPreview')" @click="preview"/><q-btn v-else unelevated no-caps color="primary" :loading="busy" :label="t('alerts.transferApply')" @click="transfer"/></q-card-actions>
    </q-card>
  </q-dialog>
</template>
