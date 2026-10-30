<script setup lang="ts">
import {computed} from 'vue'
import {t} from '../i18n'
import {backendName,clientName,requestState,requestTitle,reviewParameters} from '../mcp-presentation'
const props=defineProps<{request:any;client?:any;organization?:string;busy?:boolean;actions?:boolean;authentication?:string;account?:string;autoAuthenticate?:boolean}>()
defineEmits<{decide:[id:string,approve:boolean]}>()
const authorizationLabel=computed(()=>t(props.authentication==='macos_local_authentication'?'Authorize with Touch ID':'Authorize with system authentication'))
const reading=computed(()=>props.request.tool==='authorize_connection')
const parameters=computed(()=>reviewParameters(props.request))
function format(value:unknown):string{return typeof value==='string'?value:JSON.stringify(value,null,2)}
</script>
<template>
  <article class="mcp-review" :id="'request-'+request.id">
    <div class="mcp-review-heading"><q-icon :name="reading?'verified_user':'fact_check'" size="28px" color="primary"/><div><h2>{{requestTitle(request)}}</h2><p>{{clientName(client || request.arguments?.client)}}</p></div></div>
    <p v-if="reading" class="mcp-scope">{{t('Allow this agent to query your inventory, telemetry, alerts and incidents for 5 minutes. Changes require a separate approval.')}}</p>
    <p v-else class="mcp-scope">{{t('Review the exact action below. This approval applies only to this request.')}}</p>
    <dl class="mcp-context"><div><dt>{{t('Organization')}}</dt><dd>{{organization || t('Selected organization')}}</dd></div><div><dt>{{t('Backend')}}</dt><dd>{{backendName(request.context?.backend)}}</dd></div><div v-if="account"><dt>{{t('Signed in as')}}</dt><dd>{{account}}</dd></div><div v-if="request.state!=='approval_required'"><dt>{{t('Status')}}</dt><dd>{{requestState(request.state)}}</dd></div></dl>
    <div v-if="!reading && Object.keys(parameters).length" class="mcp-parameters"><h3>{{t('Action parameters')}}</h3><dl><div v-for="(value,key) in parameters" :key="key"><dt>{{key}}</dt><dd><pre>{{format(value)}}</pre></dd></div></dl></div>
    <p class="mcp-client-note">{{t('The client name is self-reported. Access stays within your selected account and organization.')}}</p>
    <q-expansion-item dense :label="t('Technical details')" class="mcp-technical"><pre>{{JSON.stringify({request_id:request.id,client:client || request.arguments?.client,backend:request.context?.backend,organization:request.context?.organization,expires_at:new Date(request.expires_at*1000).toISOString(),parameters},null,2)}}</pre></q-expansion-item>
    <div v-if="actions && request.state==='approval_required'" class="mcp-review-actions"><q-btn no-caps flat :disable="busy" :label="t('Cancel')" @click="$emit('decide',request.id,false)"/><div v-if="autoAuthenticate" class="mcp-touch-waiting" role="status"><q-spinner size="20px"/><span>{{t(authentication==='macos_local_authentication'?'Use Touch ID in the system prompt':'Complete authentication in the system prompt')}}</span></div><q-btn v-else no-caps color="primary" icon="fingerprint" :loading="busy" :label="authorizationLabel" @click="$emit('decide',request.id,true)"/></div>
  </article>
</template>
<style scoped>
.mcp-review{padding:24px;border:1px solid var(--i7y-separator);border-radius:12px;background:var(--i7y-surface,#fff);overflow-wrap:anywhere}.mcp-review-heading{display:flex;gap:12px;align-items:center}.mcp-review h2{font-size:20px;line-height:28px;font-weight:600;margin:0}.mcp-review-heading p{margin:2px 0;color:var(--i7y-muted)}.mcp-scope{font-size:14px;line-height:22px;margin:20px 0}.mcp-context{margin:0;display:grid;gap:12px}.mcp-context>div{display:flex;justify-content:space-between;gap:16px}.mcp-context dt,.mcp-parameters dt{color:var(--i7y-muted)}.mcp-context dd{margin:0;text-align:right;font-weight:500}.mcp-client-note{font-size:12px;line-height:19px;color:var(--i7y-muted);margin:20px 0 12px}.mcp-technical pre,.mcp-parameters pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:19px;margin:0;max-height:260px;overflow:auto}.mcp-technical pre{padding:12px}.mcp-parameters{margin-top:20px}.mcp-parameters h3{font-size:14px;font-weight:600;margin:0 0 12px}.mcp-parameters dl{display:grid;gap:12px}.mcp-parameters dd{margin:4px 0 0}.mcp-touch-waiting{display:flex;align-items:center;gap:10px;color:var(--q-primary);font-size:14px;line-height:22px}.mcp-review-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding-top:20px}.body--dark .mcp-review{background:var(--i7y-navigation,#18181b)}
</style>
