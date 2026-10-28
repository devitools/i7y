<script setup lang="ts">
import { ref, watch } from 'vue'
import { inventoryPage, management } from '../api'
import { deleteContainers } from '../bulk-delete.ts'
import { t } from '../i18n'
const props=defineProps({route:Object,canEdit:Boolean})
const emit=defineEmits(['back','saved'])
const records=ref([]),loading=ref(false),busy=ref(false),error=ref('')
let request=0
watch(()=>[props.route.ids,props.canEdit],async()=>{
  const current=++request
  records.value=[];error.value=''
  if(!props.canEdit || !props.route.ids?.length)return
  loading.value=true
  try {
    const result=await inventoryPage('containers',{ids:props.route.ids,perPage:100,statuses:[]},{force:true})
    if(current===request)records.value=result.items
  } catch {error.value=t('Unable to load the inventory. Check that PocketBase is running and try again.')}
  finally {if(current===request)loading.value=false}
},{immediate:true})
async function submit() {
  if(busy.value || loading.value || !props.canEdit || !records.value.length)return
  busy.value=true;error.value=''
  try {
    const result=await deleteContainers(records.value.map(row=>row.id),id=>management.remove('containers',id))
    records.value=records.value.filter(row=>result.failed.some(failure=>failure.id===row.id))
    if(!result.failed.length)emit('saved','containers')
    else error.value=`${result.deleted.length} ${t('deleted')}. ${result.failed.length} ${t('could not be deleted. Retry the remaining records.')}`
  } finally {busy.value=false}
}
</script>
<template>
  <q-page class="q-pa-md inventory-page">
    <div class="page-heading"><h1>{{t('Delete selected containers')}}</h1><q-btn flat no-caps icon="arrow_back" :label="t('Back to list')" :disable="busy" @click="emit('back')"/></div>
    <q-card flat bordered class="q-pa-lg">
      <q-spinner v-if="loading" color="primary"/>
      <p v-else-if="!canEdit">{{t('Sign in to manage the inventory.')}}</p>
      <template v-else>
        <q-banner v-if="error" class="bg-red-1 text-negative rounded-borders q-mb-md" role="alert">{{error}}</q-banner>
        <p>{{records.length}} {{t('containers selected')}}</p>
        <p>{{t('These records will be permanently removed from the inventory. Containers on the servers are not stopped or deleted.')}}</p>
        <q-list bordered separator class="rounded-borders"><q-item v-for="row in records" :key="row.id"><q-item-section><q-item-label>{{row.name}}</q-item-label><q-item-label caption>{{row.server?.name}} · {{row.server?.account}}</q-item-label></q-item-section><q-item-section side>{{row.state}}</q-item-section></q-item></q-list>
        <p v-if="!records.length && !loading">{{t('No records found')}}</p>
        <div class="row justify-end q-gutter-sm q-mt-md"><q-btn flat no-caps :label="t('Cancel')" :disable="busy" @click="emit('back')"/><q-btn unelevated no-caps color="negative" icon="delete_outline" :label="t('Delete permanently')" :loading="busy" :disable="!records.length" @click="submit"/></div>
      </template>
    </q-card>
  </q-page>
</template>
