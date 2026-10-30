<script setup lang="ts">
import {ref,watch} from 'vue'
import {invoke} from '@tauri-apps/api/core'
import {activeOrganization,management} from '../api'
import {desktopRuntime} from '../desktop-backend'
import {controllerError,type ControllerPing} from '../controller-api'
import {t} from '../i18n'
import PageHeader from './PageHeader.vue'
const props=defineProps<{serverId:string;returnTo?:string|null}>()
const busy=ref(false),error=ref(''),result=ref<ControllerPing|null>(null)
const targetLabel=ref(props.serverId)
let generation=0
watch(()=>[props.serverId,activeOrganization.value],async()=>{const request=++generation;result.value=null;error.value='';busy.value=false;targetLabel.value=props.serverId;if(!props.serverId || !activeOrganization.value)return;try{const server=await management.get('servers',props.serverId);if(request===generation)targetLabel.value=server.name || server.ip || props.serverId}catch{}},{immediate:true})
async function ping(){
  if(busy.value || !desktopRuntime || !activeOrganization.value)return
  const request=++generation,organization=activeOrganization.value,target=props.serverId
  busy.value=true;error.value='';result.value=null
  try{const server=await management.get('servers',target);if(request!==generation)return;const reachable=await invoke<boolean>('ping_server',{address:server.ip,port:10222});if(request===generation)result.value={version:1,backend:'',organization,target,reachable,checked_at:Math.floor(Date.now()/1000)}}
  catch(cause){if(request===generation){const message=controllerError(cause) || ({invalid_profile:'Review the SSH host, port, user and agent settings.',authentication_denied:'SSH authorization was denied. Check the SSH identity and server access.',host_key_mismatch:'The host key does not match. Verify the controller identity before reconnecting.',connection_failed:'Unable to connect to the automation host.'})[String(cause)];error.value=t(message?.includes(' ')?message:'Unable to run Ansible ping. Check the automation host settings and target permissions.')}}
  finally{if(request===generation)busy.value=false}
}
</script>
<template>
  <q-page class="q-pa-md inventory-page">
    <PageHeader :title="t('Ansible ping')" :breadcrumbs="[{label:t('Servers'),href:returnTo || '#/servers'}]" />
    <q-card flat bordered class="q-pa-lg">
      <p>{{t('Test the server connection through Ansible on the automation host. No server configuration is changed.')}}</p>
      <p>{{t('Server')}}: {{targetLabel}}</p>
      <q-banner v-if="!desktopRuntime" class="q-mb-md">{{t('This action is available in the desktop app.')}}</q-banner>
      <q-banner v-if="error" class="bg-red-1 text-negative q-mb-md" role="alert">{{error}}</q-banner>
      <q-banner v-if="result" class="q-mb-md" :class="result.reachable?'text-positive':'text-negative'" role="status">{{t(result.reachable?'Ansible returned pong. The server connection is working.':'Ansible ping failed. Check inventory, SSH access and Python on the server.')}}</q-banner>
      <div class="row items-center q-gutter-sm"><q-btn v-if="desktopRuntime" color="primary" unelevated no-caps icon="network_check" :label="t('Run ping')" :loading="busy" :disable="!activeOrganization" @click="ping"/><q-btn flat no-caps :label="t('Automation host')" href="#/desktop/controller"/></div>
    </q-card>
  </q-page>
</template>
