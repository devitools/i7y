<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount} from 'vue'
import {listen} from '@tauri-apps/api/event'
import {invoke} from '@tauri-apps/api/core'
import {activeOrganization,management} from '../api'
import {desktopRuntime} from '../desktop-backend'
import {t} from '../i18n'
import {summarizeCopySteps,type CopyStep} from '../copy-progress'
import PageHeader from './PageHeader.vue'
const props=defineProps<{projectId:string;returnTo?:string|null}>()
interface CopyFailure {stage?:string;name?:string;error?:string;rc?:number;command?:string}
interface CopyPreview {error_detail?:CopyFailure;operation_id:string;source_domain:string;destination_domain:string;source_root:string;destination_root:string;database_name:string;web_name:string;volume_name:string;network_name:string;file_count:number;expires_at:number;runtime?:string;error?:string;review_required?:boolean;refresh_preview?:boolean}
const project=ref(null),server=ref(null),domain=ref(''),confirmation=ref(''),loading=ref(false),busy=ref(false),error=ref(''),preview=ref<CopyPreview|null>(null),result=ref<CopyPreview|null>(null),started=ref(false)
const valid=computed(()=>domain.value.length<=253 && domain.value.includes('.') && domain.value!==project.value?.name && domain.value.split('.').every(part=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)))
const tasks=ref<string[]>([]),progressId=ref(''),failedTask=ref<string|null>(null)
const steps=ref<CopyStep[]>([])
const failure=ref<CopyFailure|null>(null)
function showFailure(value:CopyPreview){failure.value=value.error_detail || null;error.value=t(failure.value?.error || value.error || 'The copy was interrupted. Inspect its operation state before trying again.')}
const businessSteps=computed(()=>summarizeCopySteps(steps.value))
function stepIcon(state:string){return ({completed:'check_circle',reused:'skip_next',failed:'error_outline',running:'pending'} as Record<string,string>)[state] || 'radio_button_unchecked'}
const progressLabel=computed(()=>{
 if(result.value)return t('Project copied')
 if(error.value && !busy.value)return t('Copy paused')
 const task=steps.value.find(step=>step.state==='running')?.name || tasks.value.filter(task=>!/Remove transient/.test(task)).at(-1) || ''
 if(/Back up/.test(task))return t('Backing up the database…')
 if(/Copy files/.test(task))return t('Copying project files…')
 if(/Restore/.test(task))return t('Restoring the copied database…')
 if(/domain|WordPress/.test(task))return t('Updating the copied site…')
 if(/destination|Complete|completed/.test(task))return t('Starting the copied site…')
 return t('Preparing the copy…')
})
let progressTimer:ReturnType<typeof setTimeout>|undefined
let progressActive=false
function stopProgress(){progressActive=false;clearTimeout(progressTimer)}
onBeforeUnmount(stopProgress)
async function track<T>(phase:string,action:()=>Promise<T>,operationId?:string):Promise<T>{
 stopProgress();tasks.value=[];steps.value=[];failedTask.value=null;progressId.value='';progressActive=true
 const scope=generation
 const poll=async(id:string)=>{
  try{const value=await invoke<{tasks:string[];failed_task:string|null;steps?:CopyStep[]}>('project_copy_progress',{organization:activeOrganization.value,operationId:id,phase});if(progressActive && scope===generation){tasks.value=[...new Set(value.tasks)];steps.value=value.steps || tasks.value.map(name=>({name,state:name===value.failed_task?'failed':'completed'}));failedTask.value=value.failed_task}}catch{}
  if(progressActive && scope===generation)progressTimer=setTimeout(()=>poll(id),2000)
 }
 const unlisten=await listen<{operation_id:string;phase:string}>('project-copy-started',event=>{if(event.payload.phase===phase && scope===generation && (!operationId || event.payload.operation_id===operationId)){progressId.value=event.payload.operation_id;void poll(progressId.value)}})
 try{return await action()}finally{if(scope===generation)stopProgress();unlisten();if(progressId.value && scope===generation){try{const value=await invoke<{tasks:string[];failed_task:string|null;steps?:CopyStep[]}>('project_copy_progress',{organization:activeOrganization.value,operationId:progressId.value,phase});if(scope===generation){tasks.value=[...new Set(value.tasks)];steps.value=value.steps || tasks.value.map(name=>({name,state:name===value.failed_task?'failed':'completed'}));failedTask.value=value.failed_task}}catch{}}}
}
let generation=0
watch(()=>[props.projectId,activeOrganization.value],async()=>{stopProgress();const current=++generation;project.value=null;server.value=null;preview.value=null;result.value=null;domain.value='';tasks.value=[];steps.value=[];failure.value=null;failedTask.value=null;progressId.value='';started.value=false;busy.value=false;error.value='';loading.value=true;try{const row=await management.get('projects',props.projectId);const host=await management.get('servers',row.server);if(current===generation){project.value=row;server.value=host}}catch{if(current===generation)error.value=t('Unable to load the selected project.')}finally{if(current===generation)loading.value=false}},{immediate:true})
watch(domain,()=>{preview.value=null;confirmation.value='';error.value=''})
async function inspect(){
 if(!desktopRuntime || busy.value || !valid.value || !activeOrganization.value || !server.value || started.value)return
 const current=generation;busy.value=true;error.value='';failure.value=null;preview.value=null
 try{const value=await track('preview',()=>invoke<CopyPreview>('project_copy_preview',{organization:activeOrganization.value,target:{address:server.value.ip,port:10222,source_path:project.value.path,source_domain:project.value.name,destination_domain:domain.value}}));if(current===generation){if(value.error)showFailure(value);else {preview.value=value;confirmation.value=value.destination_domain}}}
 catch{if(current===generation)error.value=t('Unable to inspect this project. Check the automation host connection and project layout.')}
 finally{if(current===generation)busy.value=false}
 if(current===generation && preview.value && !error.value)await execute()
}
async function execute(){
 if(!preview.value || busy.value || confirmation.value!==preview.value.destination_domain || !activeOrganization.value || started.value)return
 const current=generation;started.value=true;busy.value=true;error.value='';failure.value=null
 try{const value=await track('execute',()=>invoke<CopyPreview>('project_copy_execute',{organization:activeOrganization.value,operationId:preview.value.operation_id,confirmation:confirmation.value}),preview.value.operation_id);if(current===generation){if(value.error){showFailure(value);if(value.refresh_preview)preview.value=null}else result.value=value}}
 catch{if(current===generation)error.value=t('The copy was interrupted. Inspect its operation state before trying again.')}
 finally{if(current===generation){busy.value=false;if(!result.value)started.value=false}}
}
</script>
<template>
 <q-page class="q-pa-md inventory-page">
  <PageHeader :title="t('Copy project')" :breadcrumbs="[{label:t('Projects'),href:returnTo || '#/projects'}]" />
  <q-banner v-if="error" class="q-mb-md text-negative" role="alert"><div>{{error}}</div><div v-if="failure" class="text-caption">{{t(businessSteps.find(step=>step.id===failure.stage)?.label || 'Technical details')}}<span v-if="failure.rc!=null"> · Exit {{failure.rc}}</span><span v-if="failure.command"> · {{failure.command}}</span></div></q-banner>
  <q-banner v-if="!desktopRuntime" class="q-mb-md">{{t('This action is available in the desktop app.')}}</q-banner>
  <q-card v-if="busy || tasks.length" flat bordered class="q-pa-md q-mb-md" role="status" aria-live="polite">
   <div class="text-subtitle1">{{t('Operation progress')}}</div>
   <q-linear-progress v-if="busy" indeterminate color="primary" class="q-my-sm"/>
   <div class="q-my-sm">{{progressLabel}}</div>
   <div v-if="error && !busy" class="text-caption text-grey q-mb-sm">{{t('Completed steps are kept when you resume.')}}</div>
   <div v-for="step in businessSteps" :key="step.id" class="row items-center q-gutter-sm q-py-xs"><q-icon :name="stepIcon(step.state)" :color="step.state==='failed'?'negative':step.state==='pending'?'grey':step.state==='running'?'primary':'positive'"/><span>{{t(step.label)}}</span><span class="text-caption text-grey">{{t(step.state==='reused'?'Already completed':step.state==='pending'?'Waiting':step.state==='running'?'In progress':step.state==='failed'?'Failed':'Completed')}}</span></div>
   <q-expansion-item v-if="tasks.length" :label="t('Technical details')" dense>
   <div v-for="(step,index) in steps" :key="index" class="row items-center q-gutter-sm q-py-xs"><q-icon :name="stepIcon(step.state)" :color="step.state==='failed' ? 'negative' : step.state==='running' ? 'primary' : 'positive'"/><span>{{step.name}}</span><span v-if="step.state==='reused'" class="text-caption text-grey">{{t('Already completed')}}</span></div>
   </q-expansion-item>
  </q-card>
  <q-spinner v-if="loading" color="primary"/>
  <q-card v-else-if="project && server" flat bordered class="q-pa-lg copy-card">
   <p class="text-h6">{{project.name}}</p><p>{{t('Server')}}: {{server.name || server.ip}} · {{server.ip}}</p>
   <p>{{t('Copy this project to a new domain on the same server. The original stays running.')}}</p>
   <q-input v-model="domain" outlined :label="t('New site domain')" placeholder="copy.example.com" :disable="busy || started" autocomplete="off" spellcheck="false"/>
   <q-btn class="q-mt-md" color="primary" unelevated no-caps :label="t(preview && error ? 'Resume copy' : 'Copy project')" :loading="busy" :disable="!valid || !desktopRuntime || started" @click="preview && error ? execute() : inspect()"/>
  </q-card>
  <q-card v-if="result" flat bordered class="q-pa-lg q-mt-md copy-card" role="status"><h2 class="text-h6 text-positive q-mt-none">{{t('Project copied')}}</h2><p><code>{{result.destination_root}}</code></p><p>{{t('Files, database, plugins and theme settings have been copied. Check the new site before using it.')}}</p><p>{{t('Operation')}}: <code>{{result.operation_id}}</code></p></q-card>
 </q-page>
</template>
<style scoped>
.copy-card{width:100%;min-width:0}.copy-card code{overflow-wrap:anywhere}
</style>
