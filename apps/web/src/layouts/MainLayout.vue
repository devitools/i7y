<template>
  <q-layout view="lHh Lpr lFf">
    <q-header :class="dark ? 'bg-dark text-white' : 'bg-white text-grey-9'" bordered>
      <q-toolbar class="q-px-md">
        <q-btn
          flat
          dense
          round
          icon="menu"
          :aria-label="t('Open menu')"
          @click="leftDrawerOpen=!leftDrawerOpen"
        />

        <q-toolbar-title class="row items-center no-wrap text-weight-bold">
          <q-icon name="hub" color="primary" size="24px" class="q-mr-sm" />
          i7y
        </q-toolbar-title>

        <slot name="session" />
      </q-toolbar>
    </q-header>

    <q-drawer v-model="leftDrawerOpen" show-if-above dark :width="232" class="app-drawer">
      <div class="drawer-controls">
        <q-select v-model="locale" :options="languageOptions" emit-value map-options dense borderless dark :aria-label="t('Language')" class="language-select" />
        <span class="backend-state"><i :class="{offline:error,pending:loading}" /><span>{{error ? t('API unavailable') : loading ? t('Loading') : 'API'}}</span></span>
        <q-btn flat round dense :icon="dark ? 'light_mode' : 'dark_mode'" :aria-label="t('Toggle theme')" @click="dark=!dark" />
      </div>
      <div v-if="$slots.organization" class="drawer-organization"><slot name="organization" /></div>
      <q-list padding class="app-drawer__list">
        <template v-for="section in navSections" :key="section.label">
          <q-item-label header class="app-drawer__section-label">{{ section.label }}</q-item-label>

          <q-item
            v-for="item in section.items"
            :key="item.id"
            clickable
            dense
            @click="selectView(item.id)"
            :active="activeView===item.id && !activeWorkspace"
            class="app-drawer__item"
            active-class="app-drawer__item--active"
          >
            <q-item-section avatar class="app-drawer__item-icon">
              <q-icon :name="item.icon" size="18px" />
            </q-item-section>
            <q-item-section class="text-body2">{{ item.name }}</q-item-section>
          </q-item>
        </template>
        <q-item-label header class="app-drawer__section-label row justify-between">{{t('Your workspaces')}}<span>{{workspaces.length}}</span></q-item-label>
        <div class="q-px-md q-py-sm"><q-toggle v-model="onlyWithServers" :label="t('Only workspaces with servers')" dark dense size="xs" class="workspace-toggle" /></div>
        <q-item v-for="workspace in workspaces" :key="workspace.login" clickable dense class="app-drawer__item" :active="activeWorkspace===workspace.login" active-class="app-drawer__item--active" @click="selectWorkspace(workspace.login)">
          <q-item-section avatar class="app-drawer__item-icon"><q-icon name="dns" size="18px" /></q-item-section>
          <q-item-section class="text-body2 ellipsis" :title="workspace.login">{{workspace.login}}</q-item-section>
          <q-item-section side class="text-grey-6 text-caption">{{workspace.count}}</q-item-section>
        </q-item>
        <q-item v-if="moreWorkspaces" clickable @click="emit('more-workspaces')"><q-item-section>{{t('Load more')}}</q-item-section></q-item>
      </q-list>
    </q-drawer>

    <q-page-container>
      <slot />
    </q-page-container>

  </q-layout>
</template>

<script setup lang="ts">
import type { NavigationItem, WorkspaceChoice } from '../types'
import { computed, ref } from 'vue'
import { useQuasar } from 'quasar'
import { dark } from '../theme'
import { locale, t, languageOptions } from '../i18n'
const props = defineProps<{nav?: NavigationItem[]; activeView?: string; activeWorkspace?: string; workspaces?: WorkspaceChoice[]; loading?: boolean; error?: string; moreWorkspaces?: boolean}>()
const emit = defineEmits(['navigate','workspace','more-workspaces'])
const onlyWithServers = defineModel('onlyWithServers')
const leftDrawerOpen = ref(true)
const q = useQuasar()
const navSections = computed(() => [{label:t('Inventory'),items:props.nav}])
function selectView(id) { emit('navigate',id); if(q.screen.lt.md) leftDrawerOpen.value=false }
function selectWorkspace(login) { emit('workspace',login); if(q.screen.lt.md) leftDrawerOpen.value=false }
</script>

<style lang="scss" scoped>
.app-drawer {
  background: $sidebar-bg;

  &__brand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 18px 16px;
    color: #fff;
    font-size: 14px;
  }

  &__section-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #71717a;
    padding: 16px 16px 6px;
    min-height: 0;
  }

  &__item {
    border-radius: 8px;
    margin: 1px 8px;
    min-height: 36px;

    &--active {
      color: #fff;
      background: rgba(255, 255, 255, 0.08);
    }
  }

  &__item-icon {
    min-width: 28px;
  }

  &__list {
    padding-bottom: 24px;
  }
}

.workspace-toggle {font-size:11px}
.backend-state {font-size:12px;color:#71717a;display:flex;align-items:center;gap:6px}
.backend-state i {width:6px;height:6px;border-radius:50%;background:#22c55e}
.language-select {min-width:90px;font-size:12px}
@media(max-width:600px){.backend-state{display:none}.q-toolbar__title{font-size:18px}.language-select{min-width:80px}}
</style>

<style scoped>
.drawer-organization{padding:16px 16px 0}
.drawer-controls{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.08);gap:8px;color:#e4e4e7}
.drawer-controls .language-select{width:58px;min-width:58px;font-size:12px}
.drawer-controls .backend-state{display:flex;color:#a1a1aa;font-size:11px;gap:5px}
.drawer-controls .backend-state i{width:6px;height:6px;border-radius:50%;background:#22c55e}
.drawer-controls .backend-state i.offline{background:#ef4444}
.drawer-controls .backend-state i.pending{background:#f59e0b}
</style>
