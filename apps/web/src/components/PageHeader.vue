<script setup lang="ts">
import PageActions from './PageActions.vue'
import { t } from '../i18n'

export type PageAction = {
  label: string
  icon?: string
  href?: string
  onClick?: () => void
  color?: string
  outline?: boolean
  disable?: boolean
  loading?: boolean
}

export type BreadcrumbItem = { label: string; href?: string; onClick?: () => void }

const props = defineProps<{
  title: string
  breadcrumbs?: BreadcrumbItem[]
  actions?: PageAction[]
}>()

</script>

<template>
  <header class="page-header">
    <nav v-if="breadcrumbs?.length" class="page-breadcrumbs" aria-label="Breadcrumb">
      <template v-for="(item, index) in breadcrumbs" :key="`${item.label}-${index}`">
        <q-icon v-if="index" name="chevron_right" size="16px" aria-hidden="true" />
        <a v-if="item.href || item.onClick" :href="item.href" @click="item.onClick"><q-icon v-if="index===0" name="arrow_back" size="16px" aria-hidden="true" />{{ item.label }}</a>
        <span v-else >{{ item.label }}</span>
      </template>
    </nav>
    <div class="page-heading">
      <h1>{{ title }}</h1>
      <PageActions :actions="actions" />
    </div>
  </header>
</template>
