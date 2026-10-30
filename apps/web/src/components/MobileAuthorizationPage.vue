<script setup lang="ts">
import { ref } from 'vue'
import { authStore, pb } from '../api'
import { locale } from '../i18n'
import messages from '../locales/mobile'
const label=(key: keyof typeof messages.en)=>messages[locale.value]?.[key] || messages.en[key]
const params=new URLSearchParams(window.location.hash.split('?')[1] || '')
const request=params.get('request') || '',challenge=params.get('challenge') || '',instance=params.get('instance_id') || ''
const valid=/^[a-f0-9]{64}$/.test(request) && /^[a-f0-9]{64}$/.test(challenge) && /^[a-zA-Z0-9_-]{16,128}$/.test(instance)
const busy=ref(false),done=ref(false),cancelled=ref(false),error=ref(false)
const callback='com.devitools.i7y.mobile://auth/callback?request='+encodeURIComponent(request)
async function authorize() {
  busy.value=true;error.value=false
  try {
    await pb.send('/api/i7y/mobile/v1/auth/authorize',{method:'POST',body:{request,challenge,instance_id:instance},requestKey:null})
    done.value=true
    window.location.assign(callback)
  }catch{error.value=true}finally{busy.value=false}
}
</script>
<template>
  <q-page class="mobile-consent">
    <q-card flat bordered class="mobile-consent-card">
      <q-icon name="hub" color="primary" size="40px" /><h1>i7y</h1>
      <template v-if="done"><h2>{{label('authorized')}}</h2><q-btn color="primary" no-caps :label="label('return')" :href="callback" /></template>
      <template v-else-if="cancelled"><p>{{label('cancelled')}}</p></template>
      <template v-else>
        <h2>{{label('title')}}</h2><p>{{label('description')}}</p>
        <p class="mobile-consent-account">{{authStore.record?.email}}</p>
        <template v-if="valid"><p>{{label('compare')}}</p><strong class="mobile-consent-code">{{request.slice(0,8).toUpperCase()}}</strong></template>
        <q-banner v-if="error || !valid" class="text-negative q-mt-md" role="alert">{{label('error')}}</q-banner>
        <div class="mobile-consent-actions"><q-btn unelevated color="primary" no-caps :label="label('authorize')" :disable="!valid" :loading="busy" @click="authorize" /><q-btn flat no-caps :label="label('cancel')" :disable="busy" @click="cancelled=true" /></div>
      </template>
    </q-card>
  </q-page>
</template>
<style scoped>
.mobile-consent{display:flex;align-items:center;justify-content:center;padding:24px}.mobile-consent-card{width:100%;max-width:440px;padding:32px;text-align:center;border-radius:20px}h1{font-size:28px;line-height:1.2;margin:12px 0 24px}h2{font-size:22px;line-height:1.4;margin:0 0 16px}p{line-height:1.6}.mobile-consent-account{overflow-wrap:anywhere;font-weight:600}.mobile-consent-code{display:block;font-size:28px;letter-spacing:4px;font-family:monospace;margin:20px}.mobile-consent-actions{display:grid;gap:10px;margin-top:24px}
</style>
