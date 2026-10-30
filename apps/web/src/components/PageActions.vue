<script setup lang="ts">
import { useQuasar } from 'quasar'
import { t } from '../i18n'
import type { PageAction } from './PageHeader.vue'
defineProps<{ actions?: PageAction[] }>()
const q = useQuasar()
</script>
<template>
      <div v-if="actions?.length && !q.screen.lt.md" class="page-actions">
        <q-btn
          v-for="(action, index) in actions"
          :key="`${action.label}-${index}`"
          :href="action.href"
          :icon="action.icon"
          :label="action.label"
          :color="action.color || 'primary'"
          :outline="action.outline"
          :disable="action.disable"
          :loading="action.loading"
          :unelevated="!action.outline"
          no-caps
          @click="action.onClick"
        />
      </div>
      <q-btn v-else-if="actions?.length" class="compact-page-actions" flat round icon="more_horiz" :aria-label="t('More actions')">
        <q-menu anchor="bottom right" self="top right">
          <q-list dense class="page-action-menu">
            <q-item
              v-for="(action, index) in actions"
              :key="`${action.label}-${index}`"
              clickable
              :href="action.href"
              :disable="action.disable || action.loading"
              v-close-popup
              @click="action.onClick"
            >
              <q-item-section v-if="action.icon" avatar><q-icon :name="action.icon" :color="action.color" /></q-item-section>
              <q-item-section>{{ action.label }}</q-item-section>
            </q-item>
          </q-list>
        </q-menu>
      </q-btn>
</template>
