<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useQuasar } from 'quasar'
import { management } from '../api'
import { t, locale } from '../i18n'
import PageHeader from './PageHeader.vue'
import { routeHash } from '../routes'
import { guideBlocks, guideText } from '../agent-guide'
import ptGuide from '../locales/pt-BR/agent-installation.md?raw'
import enGuide from '../../../../docs/install-agent.en.md?raw'
import ukGuide from '../locales/uk/agent-installation.md?raw'
const guides={'pt-BR':ptGuide,en:enGuide,uk:ukGuide}
const props=defineProps({serverId:{type:String,required:true}})
const q=useQuasar(), server=ref(null), error=ref(''), loading=ref(true)
const telemetry=computed(()=>routeHash({view:'telemetry',server:props.serverId}))
const back=computed(()=>server.value?routeHash({view:'projects',server:server.value.id}):'#/servers')
const blocks=computed(()=>guideBlocks((guides[locale.value] || enGuide).replaceAll('https://inventory.example.com',window.location.origin).replaceAll('server.example.com',server.value?.ip || 'server.example.com')))
async function copy(text){try{await navigator.clipboard.writeText(text);q.notify({message:t('Copied to clipboard'),color:'positive'})}catch{q.notify({message:t('Unable to copy'),color:'negative'})}}
onMounted(async()=>{try{server.value=await management.get('servers',props.serverId)}catch{error.value=t('Unable to load data. Please try again.')}finally{loading.value=false}})
</script>
<template>
<q-page class="q-pa-md inventory-page">
 <PageHeader :title="t('Install daemon')" :breadcrumbs="[{label:t('Projects'),href:back}]" />
 <q-spinner v-if="loading" color="primary" />
 <q-banner v-else-if="error" class="bg-negative text-white" role="alert">{{error}}</q-banner>
 <template v-else>
  <q-card flat bordered class="q-pa-md q-mb-md"><p>{{t('Follow the guide below and create a credential for this server. SSH user, port and architecture must be confirmed before running the commands.')}}</p><q-btn color="primary" no-caps icon="key" :label="t('Open server telemetry')" :href="telemetry" /></q-card>
  <q-card flat bordered class="agent-guide q-pa-lg">
   <template v-for="(block,index) in blocks" :key="index">
    <component v-if="block.type==='heading'" :is="block.level===1?'h2':'h3'">{{block.text}}</component>
    <div v-else-if="block.type==='code'" class="guide-code"><q-btn flat dense round icon="content_copy" :aria-label="t('Copy command')" @click="copy(block.text)"/><pre><code>{{block.text}}</code></pre></div>
    <q-markup-table v-else-if="block.type==='table'" flat bordered wrap-cells class="q-my-md"><thead><tr><th v-for="(cell,n) in block.rows[0]" :key="n" class="text-left"><component v-for="(part,k) in guideText(cell)" :key="k" :is="part.type">{{part.text}}</component></th></tr></thead><tbody><tr v-for="(row,n) in block.rows.slice(1)" :key="n"><td v-for="(cell,j) in row" :key="j"><component v-for="(part,k) in guideText(cell)" :key="k" :is="part.type">{{part.text}}</component></td></tr></tbody></q-markup-table>
    <p v-else :class="{'guide-item':block.type==='item'}"><component v-for="(part,k) in guideText(block.text)" :key="k" :is="part.type">{{part.text}}</component></p>
   </template>
  </q-card>
 </template>
</q-page>
</template>
<style scoped>
.agent-guide{width:100%;line-height:1.7}.agent-guide h2{font-size:22px;line-height:1.4;margin:0 0 20px}.agent-guide h3{font-size:18px;line-height:1.4;margin:32px 0 16px}.guide-code{position:relative;background:rgba(127,127,127,.09);border-radius:8px;margin:16px 0}.guide-code .q-btn{position:absolute;right:8px;top:8px}.guide-code pre{overflow:auto;padding:20px 52px 20px 16px;line-height:1.6;font-size:13px;margin:0}.guide-item{margin:6px 0;padding-left:16px;border-left:2px solid var(--q-primary)}.agent-guide p code,.agent-guide td code{overflow-wrap:anywhere;font-size:.9em}
</style>
