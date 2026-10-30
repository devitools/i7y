<template>
  <q-dialog v-model="isOpen">
    <q-card class="record-detail-card">
      <q-card-section class="row items-center no-wrap q-pb-sm">
        <q-avatar v-if="avatarText" :color="avatarColor ?? 'primary'" text-color="white">
          {{ avatarText }}
        </q-avatar>

        <div class="q-ml-sm record-detail-heading">
          <div class="text-subtitle1 text-weight-medium">{{ title }}</div>
          <div v-if="subtitle" class="text-caption text-grey-5">{{ subtitle }}</div>
        </div>

        <q-space />

        <q-btn v-close-popup flat round dense icon="close" :aria-label="closeLabel" />
      </q-card-section>

      <q-separator />

      <q-card-section>
        <div
          v-for="field in fields"
          :key="field.label"
          class="record-detail-field q-py-xs"
        >
          <div class="text-caption text-grey-5">{{ field.label }}</div>
          <div class="text-weight-medium record-detail-value" :class="field.color ? `text-${field.color}` : ''">
            {{ field.value }}
          </div>
        </div>
      </q-card-section>

      <template v-if="$slots.actions">
        <q-separator />
        <q-card-actions align="right">
          <slot name="actions" />
        </q-card-actions>
      </template>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">


export interface DetailField {
  label: string;
  value: string;

  color?: string;
}

const isOpen = defineModel<boolean>({ required: true });

defineProps<{
  title: string;
  closeLabel: string;
  subtitle?: string;
  avatarText?: string;
  avatarColor?: string;
  fields: DetailField[];
}>();
</script>

<style scoped>
.record-detail-card {
  width: 520px;
  max-width: 90vw;
}
.record-detail-heading{min-width:0;overflow-wrap:anywhere}
.record-detail-card :deep(.q-avatar),.record-detail-card :deep(.q-card__section>.q-btn){flex-shrink:0}
.record-detail-field{display:grid;grid-template-columns:minmax(96px,.8fr) minmax(0,1.2fr);gap:4px 16px;align-items:baseline}
.record-detail-value{min-width:0;overflow-wrap:anywhere;text-align:right}
.record-detail-card :deep(.q-card__actions){flex-wrap:wrap;gap:8px}
@media(max-width:480px){.record-detail-field{grid-template-columns:minmax(0,1fr);padding-block:8px}.record-detail-value{text-align:left}}
</style>
