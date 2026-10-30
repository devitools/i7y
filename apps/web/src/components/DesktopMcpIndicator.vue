<script setup lang="ts">
import {onMounted,onUnmounted,ref} from 'vue'
import {invoke} from '@tauri-apps/api/core'
import {desktopRuntime} from '../desktop-backend'
import {t} from '../i18n'
import {pendingRequests,requestLink} from '../mcp-presentation'
const count=ref(0),href=ref(requestLink())
let timer:ReturnType<typeof setInterval>|undefined
async function update(){if(!desktopRuntime)return;try{const state=await invoke<any>('mcp_overview');const requests=pendingRequests(state.requests);count.value=requests.length;href.value=requestLink(requests[0]?.id)}catch{count.value=0}}
onMounted(()=>{void update();if(desktopRuntime)timer=setInterval(update,2000)})
onUnmounted(()=>clearInterval(timer))
</script>
<template><q-btn v-if="desktopRuntime && count" flat round icon="verified_user" :href="href" :aria-label="t('Review requests')"><q-badge color="warning" floating>{{count}}</q-badge><q-tooltip>{{t('Review requests')}}</q-tooltip></q-btn></template>
