<script setup lang="ts">
import { computed,ref,onMounted,onUnmounted } from 'vue'
import { organizationApi, management, authStore } from '../api'
import { t } from '../i18n'
const props=defineProps({token:String})
const emit=defineEmits(['accepted'])
const signedIn=ref(authStore.isValid)
const stopAuth=authStore.onChange(()=>signedIn.value=authStore.isValid)
onUnmounted(stopAuth)
const invitation=ref(null),error=ref(''),busy=ref(false),existing=ref(false),name=ref(''),password=ref(''),confirmation=ref(''),accepted=ref(false)
const matchingAccount=computed(()=>!!invitation.value && String(authStore.record?.email || '').toLowerCase()===String(invitation.value.email || '').toLowerCase())
onMounted(async()=>{try{invitation.value=await organizationApi.inspect(props.token)}catch{error.value=t('Invitation expired, revoked or already used.')}})
async function accept(){
  busy.value=true;error.value=''
  try{
    if(!authStore.isValid && existing.value)await management.signIn(invitation.value.email,password.value)
    await organizationApi.accept({token:props.token,name:name.value,password:password.value,passwordConfirm:confirmation.value})
    if(!authStore.isValid)await management.signIn(invitation.value.email,password.value)
    password.value='';confirmation.value='';accepted.value=true;emit('accepted')
  }catch(e){error.value=e.response?.message || t('Unable to complete this action.')}finally{busy.value=false}
}
</script>
<template>
  <q-page class="q-pa-lg flex flex-center invitation-page"><q-card flat bordered class="q-pa-lg invitation-card">
    <h1 class="text-h5 q-mt-none">{{t('Accept invitation')}}</h1>
    <q-banner v-if="error" class="bg-red-1 text-negative q-mb-md" role="alert">{{error}}</q-banner>
    <q-form v-if="invitation && !accepted" @submit="accept" class="q-gutter-md">
      <p>{{invitation.organization}} · {{invitation.email}} · {{t(({admin:'Administrator',editor:'Editor',reader:'Read only'})[invitation.role])}}</p>
      <template v-if="!signedIn"><q-toggle v-model="existing" :label="t('I already have a login')" /><q-input v-if="!existing" v-model="name" outlined :label="t('Name')" :rules="[v=>!!v?.trim() || t('Required field')]" /><q-input v-model="password" type="password" :autocomplete="existing?'current-password':'new-password'" outlined :label="t('Password')" :rules="[v=>!!v || t('Required field')]" /><q-input v-if="!existing" v-model="confirmation" type="password" autocomplete="new-password" outlined :label="t('Confirm password')" :rules="[v=>v===password || t('Passwords must match')]" /></template>
      <p v-else>{{authStore.record?.email}}</p>
      <q-btn v-if="signedIn && !matchingAccount" flat :label="t('Sign out')" @click="management.signOut()" />
      <q-btn type="submit" unelevated no-caps :disable="signedIn && !matchingAccount" color="primary" :label="t('Accept invitation')" :loading="busy" />
    </q-form><q-btn v-if="!signedIn && !invitation" flat no-caps class="q-mt-md" href="#/login" :label="t('Sign in')" />
    <q-btn v-if="signedIn && !invitation" flat no-caps class="q-mt-md" href="#/workspaces" :label="t('Workspaces')" />
  </q-card></q-page>
</template>

<style scoped>
.invitation-card{width:100%;max-width:480px;overflow-wrap:anywhere}
.invitation-card :deep(.q-btn__content){white-space:normal}
@media(max-width:599px){.invitation-page{padding:16px}.invitation-card{padding:20px}}
</style>
