<script setup lang="ts">
import { ref } from 'vue'
import { authStore, desktopAuthApi } from '../api'
import { t } from '../i18n'
const params=new URLSearchParams(window.location.hash.split('?')[1] || '')
const request=params.get('request') || '',challenge=params.get('challenge') || ''
const valid=/^[a-f0-9]{64}$/.test(request) && /^[a-f0-9]{64}$/.test(challenge)
const busy=ref(false),done=ref(false),cancelled=ref(false),error=ref('')
async function authorize() {
  busy.value=true;error.value=''
  try {await desktopAuthApi.authorize(request,challenge);done.value=true}
  catch {error.value=t('Unable to authorize the desktop. Start again in the app.')}
  finally {busy.value=false}
}
</script>
<template>
  <q-page class="desktop-consent-page">
    <q-card flat bordered class="desktop-consent-card">
      <div class="desktop-consent-brand"><q-icon name="hub" color="primary" size="32px" /><strong>i7y</strong></div>
      <h1>{{t('Authorize desktop')}}</h1>
      <template v-if="done || cancelled">
        <q-icon :name="done?'check_circle':'block'" :color="done?'positive':'grey'" size="40px" class="q-mb-md" />
        <p role="status">{{t(done?'Desktop authorized. You can return to the app.':'Authorization cancelled. You can close this tab.')}}</p>
      </template>
      <template v-else>
        <p class="desktop-consent-description">{{t('Only continue if you started this request in the i7y desktop app.')}}</p>
        <div class="desktop-consent-account"><q-icon name="account_circle" size="22px" /><span>{{authStore.record?.email}}</span></div>
        <template v-if="valid"><p class="desktop-consent-description">{{t('Confirm that this code matches the desktop app:')}}</p><strong class="desktop-consent-code">{{request.slice(0,8).toUpperCase()}}</strong></template>
        <q-banner v-if="error || !valid" class="text-negative q-mt-md" role="alert">{{error || t('Invalid desktop request')}}</q-banner>
        <div class="desktop-consent-actions"><q-btn unelevated color="primary" no-caps :label="t('Authorize desktop')" :disable="!valid" :loading="busy" @click="authorize" /><q-btn flat no-caps :label="t('Cancel')" :disable="busy" @click="cancelled=true" /></div>
      </template>
    </q-card>
  </q-page>
</template>
<style scoped>
.desktop-consent-page{display:flex;align-items:center;justify-content:center;padding:32px 20px}
.desktop-consent-card{width:100%;max-width:460px;padding:36px;text-align:center;border-radius:16px}
.desktop-consent-brand{display:flex;align-items:center;justify-content:center;gap:10px;font-size:24px;margin-bottom:28px}
h1{font-size:24px;line-height:1.3;margin:0 0 16px;font-weight:600}
.desktop-consent-description{opacity:.7;font-size:14px;line-height:1.6;margin:16px 0}
.desktop-consent-account span{min-width:0;overflow-wrap:anywhere}
.desktop-consent-account>.q-icon{flex-shrink:0}
.desktop-consent-account{display:flex;align-items:center;justify-content:center;gap:8px;margin:24px 0;overflow-wrap:anywhere}
.desktop-consent-code{display:block;font-family:monospace;font-size:28px;letter-spacing:4px;padding:12px;border:1px solid var(--q-separator-color, #9c9c9c40);border-radius:8px}
.desktop-consent-actions{display:flex;flex-direction:column;gap:8px;margin-top:28px}
@media(max-width:480px){.desktop-consent-card{padding:28px 24px}}
</style>
