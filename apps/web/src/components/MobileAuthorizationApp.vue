<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import en from 'quasar/lang/en-US'
import ptBR from 'quasar/lang/pt-BR'
import uk from 'quasar/lang/uk'
import { authStore, management } from '../api'
import { locale, t, languageOptions } from '../i18n'
import { dark } from '../theme'
import ManagementPage from './ManagementPage.vue'
import MobileAuthorizationPage from './MobileAuthorizationPage.vue'

const q = useQuasar()
const phase = ref<'checking' | 'login' | 'ready' | 'error'>('checking')
const authorization = ref(window.location.hash)
const loginRoute = { view: 'login' }
let active = true
let refreshing = false
let verifiedToken = ''
let unsubscribe: (() => void) | undefined
let expiryTimer: ReturnType<typeof setInterval> | undefined
const validSession = () => authStore.isValid && authStore.record?.collectionName === 'users'

watch(locale, value => q.lang.set(({en,'pt-BR':ptBR,uk})[value]), { immediate: true })

async function refreshSession() {
  if (!active || refreshing) return
  if (!validSession()) {
    verifiedToken = ''
    if (authStore.token) management.signOut()
    phase.value = 'login'
    return
  }
  const token = authStore.token
  refreshing = true
  phase.value = 'checking'
  try {
    await management.refreshSession()
    if (!active) return
    verifiedToken = validSession() ? authStore.token : ''
    phase.value = verifiedToken ? 'ready' : 'login'
  } catch (error) {
    if (!active || authStore.token !== token) return
    if ([400,401,403].includes(error?.status)) {
      management.signOut()
      phase.value = 'login'
    } else phase.value = 'error'
  } finally {
    refreshing = false
    if (active && validSession() && authStore.token !== token && authStore.token !== verifiedToken) void refreshSession()
  }
}

function changedSession() {
  if (!validSession()) {
    verifiedToken = ''
    phase.value = 'login'
  } else if (authStore.token !== verifiedToken) {
    phase.value = 'checking'
    void refreshSession()
  }
}

function changedAuthorization() { authorization.value = window.location.hash }

onMounted(() => {
  unsubscribe = authStore.onChange(changedSession)
  window.addEventListener('hashchange', changedAuthorization)
  expiryTimer = setInterval(() => { if (phase.value === 'ready' && !validSession()) management.signOut() }, 1000)
  void refreshSession()
})

onUnmounted(() => {
  active = false
  unsubscribe?.()
  if (expiryTimer) clearInterval(expiryTimer)
  window.removeEventListener('hashchange', changedAuthorization)
})
</script>

<template>
  <q-layout view="lHh Lpr lFf">
    <q-header bordered :class="dark ? 'bg-dark text-white' : 'bg-white text-grey-9'">
      <q-toolbar>
        <q-icon name="hub" color="primary" size="28px" class="q-mr-sm" />
        <q-toolbar-title class="text-weight-bold">i7y</q-toolbar-title>
        <q-select v-model="locale" :options="languageOptions" emit-value map-options dense borderless :aria-label="t('Language')" style="width:64px" class="q-mr-sm" />
        <q-btn flat round dense :icon="dark ? 'light_mode' : 'dark_mode'" :aria-label="t('Toggle theme')" @click="dark=!dark" />
      </q-toolbar>
    </q-header>
    <q-page-container>
      <q-page v-if="phase==='checking'" class="flex flex-center"><div class="text-center" role="status"><q-spinner color="primary" size="32px" /><p>{{t('Loading')}}</p></div></q-page>
      <q-page v-else-if="phase==='error'" class="q-pa-lg flex flex-center">
        <q-card flat bordered class="q-pa-lg mobile-session-error"><p role="alert">{{t('Unable to complete this action. Check your connection and permissions, then try again.')}}</p><q-btn unelevated color="primary" no-caps :label="t('Try again')" @click="refreshSession" /></q-card>
      </q-page>
      <ManagementPage v-else-if="phase==='login'" :route="loginRoute" :authenticated="false" :can-edit="false" @signed-in="refreshSession" />
      <MobileAuthorizationPage v-else :key="authorization" />
    </q-page-container>
  </q-layout>
</template>

<style scoped>
.mobile-session-error{width:100%;max-width:460px;border-radius:14px}
</style>
