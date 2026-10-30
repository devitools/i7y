<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { desktopRuntime } from '../desktop-backend'
import { t } from '../i18n'
import PageHeader from './PageHeader.vue'
import PageActions from './PageActions.vue'
import {activeOrganization} from '../api'
import {controllerError} from '../controller-api'
interface ControllerProfile {host:string;port:number;user:string;public_key:string;host_key:string;identity_file:string}
interface ControllerSettings {profile:ControllerProfile|null;default_identity_file:string;host_fingerprint:string|null;identity_fingerprint:string|null;execution_enabled:false}

const form=ref<ControllerProfile>({host:'',port:22,user:'',public_key:'',host_key:'',identity_file:''})
const saved=ref<ControllerSettings|null>(null),result=ref<{ansible_version:string|null;host_fingerprint:string;identity_fingerprint:string}|null>(null),loading=ref(false),busy=ref(false),reviewed=ref(false),error=ref(''),notice=ref('')
const labels={invalid_profile:'Review the SSH host, port, user and agent settings.',invalid_public_key:'Provide an OpenSSH public key. Private keys are not accepted.',host_key_mismatch:'The host key does not match. Verify the controller identity before reconnecting.',authentication_denied:'SSH authorization was denied. Check the SSH identity and server access.',agent_unavailable:'The SSH agent is unavailable or refused access.',open_ssh_unavailable:'Install the system OpenSSH client before testing this connection.',connection_failed:'Unable to connect to the automation host.',timed_out:'SSH diagnostic timed out. Check connectivity and SSH authentication.',invalid_diagnostic:'The automation host returned an unsupported diagnostic response.',local_storage_failed:'Unable to read or save the local SSH settings.'}
function failure(cause:unknown){const message=controllerError(cause);error.value=t(message ? labels[message] || message : labels[String(cause)] || 'Unable to connect to the automation host.')}
async function load(){
  if(!desktopRuntime)return
  loading.value=true;error.value=''
  try{saved.value=await invoke<ControllerSettings>('controller_settings');form.value=saved.value.profile || {...form.value,identity_file:saved.value.default_identity_file}}
  catch(cause){failure(cause)}finally{loading.value=false}
}
async function save(){
  busy.value=true;error.value='';notice.value='';result.value=null
  try{await invoke('save_controller_settings',{profile:{...form.value,port:Number(form.value.port)},hostKeyReviewed:reviewed.value});reviewed.value=false;await load();notice.value=t('SSH settings saved on this device.')}
  catch(cause){failure(cause)}finally{busy.value=false}
}
async function diagnose(){
  busy.value=true;error.value='';notice.value='';result.value=null
  try{result.value=await invoke('diagnose_controller',{profile:{...form.value,port:Number(form.value.port)},hostKeyReviewed:reviewed.value})}
  catch(cause){failure(cause)}finally{busy.value=false}
}
watch(activeOrganization,()=>{result.value=null;error.value=''})
onMounted(load)
</script>
<template>
  <q-page class="q-pa-md inventory-page">
    <PageHeader :title="t('Automation host')" />
    <q-banner v-if="!desktopRuntime" class="q-mb-md">{{t('SSH configuration is available in the desktop app.')}}</q-banner>
    <template v-else>
      <p>{{t('The desktop connects only to this automation host. Managed servers are reached from there.')}}</p>
      <q-banner class="q-mb-md">{{t('Test the SSH connection before saving. This does not change server configuration.')}}</q-banner>
      <q-banner v-if="error" class="bg-red-1 text-negative q-mb-md" role="alert">{{error}}</q-banner>
      <q-banner v-if="notice" class="q-mb-md" role="status">{{notice}}</q-banner>
      <q-card flat bordered class="controller-card q-pa-lg">
        <q-spinner v-if="loading" color="primary" />
        <q-form v-else class="q-gutter-y-md" @submit="save">
          <q-input v-model="form.host" outlined :label="t('SSH host')" :disable="busy" :rules="[value=>!!value || t('Required field')]" />
          <div class="row q-col-gutter-md"><q-input v-model.number="form.port" class="col-12 col-sm-4" outlined type="number" min="1" max="65535" :label="t('SSH port')" :disable="busy" /><q-input v-model="form.user" class="col-12 col-sm-8" outlined :label="t('SSH user')" :disable="busy" /></div>
          <q-input v-model="form.identity_file" outlined :label="t('SSH identity file')" :disable="busy" spellcheck="false" />

          <q-input v-model="form.host_key" outlined type="textarea" autogrow :label="t('Trusted host public key')" :hint="t('Obtain this host key through a trusted channel. It is never accepted automatically.')" :disable="busy" spellcheck="false" />
          <q-checkbox v-model="reviewed" :label="t('I verified the host key through a trusted channel.')" :disable="busy" />
          <div class="controller-actions"><q-btn type="submit" unelevated color="primary" no-caps :label="t('Save')" :disable="!reviewed || busy" /><PageActions :actions="[{label:t('Test connection'),icon:'network_check',outline:true,loading:busy,disable:!reviewed || loading || busy,onClick:diagnose}]" /></div>
        </q-form>
      </q-card>
      <q-card v-if="saved?.profile" flat bordered class="controller-card q-pa-lg q-mt-md"><h2 class="text-h6 q-mt-none">{{t('Trusted identities')}}</h2><p class="controller-fingerprint">{{t('Host')}}: {{saved.host_fingerprint}}</p><p class="controller-fingerprint q-mb-none">{{t('User')}}: {{saved.identity_fingerprint}}</p></q-card>
      <q-card v-if="result" flat bordered class="controller-card q-pa-lg q-mt-md" role="status"><h2 class="text-h6 q-mt-none">{{t('SSH connection verified')}}</h2><p>Ansible: {{result.ansible_version || '—'}}</p><p class="controller-fingerprint">{{t('Host')}}: {{result.host_fingerprint}}</p></q-card>
    </template>
  </q-page>
</template>
<style scoped>
.controller-fingerprint{overflow-wrap:anywhere;font-family:monospace}
.controller-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px}
.controller-card :deep(.q-item__section--main){min-width:0;overflow-wrap:anywhere}
.controller-card :deep(.q-item__label){overflow-wrap:anywhere}
@media(max-width:599px){.controller-card{padding:16px}.controller-card :deep(.q-item){flex-wrap:wrap;gap:8px}.controller-card :deep(.q-item__section--side){padding-left:0}}
</style>
