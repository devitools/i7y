<script setup lang="ts">
import {desktopRuntime} from '../desktop-backend'
import {t} from '../i18n'
defineProps<{serverId:string}>()
function href(serverId:string){return `#/servers/${encodeURIComponent(serverId)}/actions/ping?returnTo=${encodeURIComponent(window.location.hash)}`}
</script>
<template>
  <q-btn v-if="desktopRuntime" flat dense round icon="play_circle" :aria-label="t('Actions')" :title="t('Actions')" aria-haspopup="menu" @click.stop>
    <q-menu anchor="bottom left" self="top left"><q-list><q-item clickable v-close-popup :href="href(serverId)"><q-item-section avatar><q-icon name="network_check"/></q-item-section><q-item-section>{{t('Ansible ping')}}</q-item-section></q-item></q-list></q-menu>
  </q-btn>
</template>
