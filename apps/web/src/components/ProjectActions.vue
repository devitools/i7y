<script setup lang="ts">
import {desktopRuntime} from '../desktop-backend'
import {t} from '../i18n'
defineProps<{projectId:string}>()
function href(id:string){return `#/projects/${encodeURIComponent(id)}/actions/copy?returnTo=${encodeURIComponent(window.location.hash)}`}
</script>
<template>
 <q-btn v-if="desktopRuntime" flat dense round icon="play_circle" :aria-label="t('Actions')" :title="t('Actions')" aria-haspopup="menu" @click.stop><q-menu anchor="bottom left" self="top left"><q-list><q-item clickable v-close-popup :href="href(projectId)"><q-item-section avatar><q-icon name="content_copy"/></q-item-section><q-item-section>{{t('Copy project')}}</q-item-section></q-item></q-list></q-menu></q-btn>
</template>
