<template>
  <q-layout view="lHh Lpr lFf" class="app-layout">
    <q-header :class="dark ? 'bg-dark text-white' : 'bg-white text-grey-9'" bordered>
      <q-toolbar class="app-toolbar q-px-md">
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

    <q-drawer :key="compactNavigation ? 'compact' : 'wide'" v-model="leftDrawerOpen" :behavior="compactNavigation ? 'mobile' : 'desktop'" :dark="dark" :width="232" class="app-drawer">
      <div class="drawer-shell">
      <div class="drawer-controls">
        <q-select v-model="locale" :options="languageOptions" emit-value map-options dense borderless :dark="dark" :aria-label="t('Language')" class="language-select" />
        <span class="backend-state"><i :class="{offline:error,pending:loading}" /><span>{{error ? t('API unavailable') : loading ? t('Loading') : 'API'}}</span></span>
        <q-btn flat round dense :icon="dark ? 'light_mode' : 'dark_mode'" :aria-label="t('Toggle theme')" @click="dark=!dark" />
        <q-btn v-if="compactNavigation" flat round dense icon="close" :aria-label="t('Close menu')" @click="leftDrawerOpen=false" />
      </div>
      <div v-if="$slots.organization" class="drawer-organization"><slot name="organization" /></div>
      <div class="drawer-body">
      <q-list padding class="app-drawer__list drawer-navigation">
        <template v-for="section in navSections" :key="section.label">
          <q-item-label header class="app-drawer__section-label">{{ section.label }}</q-item-label>

          <q-item
            v-for="item in section.items"
            :key="item.id"
            clickable
            dense
            @click="selectView(item.id)"
            :active="activeView===item.id"
            :aria-current="activeView===item.id ? 'page' : undefined"
            class="app-drawer__item"
            active-class="app-drawer__item--active"
          >
            <q-item-section avatar class="app-drawer__item-icon">
              <q-icon :name="item.icon" size="18px" />
            </q-item-section>
            <q-item-section class="text-body2">{{ item.name }}</q-item-section>
          </q-item>
        </template>
      </q-list>
      <section class="drawer-workspaces">
        <q-item-label header class="app-drawer__section-label row justify-between">{{t('Your workspaces')}}<span>{{workspaces.length}}</span></q-item-label>
        <div class="q-px-md q-py-sm"><q-toggle v-model="onlyWithServers" :label="t('Only workspaces with servers')" :dark="dark" dense size="xs" class="workspace-toggle" /></div>
        <div class="workspace-scroll" tabindex="0" role="region" :aria-label="t('Your workspaces')"><q-list>
        <q-item v-for="workspace in workspaces" :key="workspace.login" clickable dense class="app-drawer__item app-drawer__workspace" :active="activeWorkspace===workspace.login" active-class="app-drawer__workspace--active" @click="selectWorkspace(workspace.login)">
          <q-item-section avatar class="app-drawer__item-icon"><q-icon name="dns" size="18px" /></q-item-section>
          <q-item-section class="text-body2 ellipsis" :title="workspace.login">{{workspace.login}}</q-item-section>
          <q-item-section side class="text-grey-6 text-caption">{{workspace.count}}</q-item-section>
        </q-item>
        <q-item v-if="moreWorkspaces" clickable @click="emit('more-workspaces')"><q-item-section>{{t('Load more')}}</q-item-section></q-item>
      </q-list></div>
      </section>
      </div>
      </div>
    </q-drawer>

    <q-page-container>
      <slot />
    </q-page-container>

  </q-layout>
</template>

<script setup lang="ts">
import type { NavigationItem, WorkspaceChoice } from '../types'
import { computed, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { dark } from '../theme'
import { locale, t, languageOptions } from '../i18n'
const props = defineProps<{nav?: NavigationItem[]; activeView?: string; activeWorkspace?: string; workspaces?: WorkspaceChoice[]; loading?: boolean; error?: string; moreWorkspaces?: boolean}>()
const emit = defineEmits(['navigate','workspace','more-workspaces'])
const onlyWithServers = defineModel('onlyWithServers')
const q = useQuasar()
const compactNavigation = computed(() => q.screen.width <= 1023)
const desktopDrawerOpen = ref(true)
const mobileDrawerOpen = ref(false)
const leftDrawerOpen = computed({
  get: () => compactNavigation.value ? mobileDrawerOpen.value : desktopDrawerOpen.value,
  set: value => { if (compactNavigation.value) mobileDrawerOpen.value = value; else desktopDrawerOpen.value = value },
})
watch(compactNavigation, () => { mobileDrawerOpen.value = false })
const navSections = computed(() => [{label:t('Inventory'),items:props.nav}])
function selectView(id) { emit('navigate',id); if(compactNavigation.value) leftDrawerOpen.value=false }
function selectWorkspace(login) { emit('workspace',login); if(compactNavigation.value) leftDrawerOpen.value=false }
</script>

<style lang="scss" scoped>
.app-drawer {
  background: var(--i7y-navigation);
  color: var(--i7y-text);

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
    color: var(--i7y-muted);
    padding: 16px 16px 6px;
    min-height: 0;
  }

  &__item {
    border-radius: 8px;
    margin: 1px 8px;
    min-height: 36px;

    &--active {
      color: var(--i7y-navigation-active-text);
      background: var(--i7y-navigation-active);
      font-weight: 600;
      box-shadow: inset 3px 0 currentColor;
    }
  }

  &__item-icon {
    min-width: 28px;
  }

  &__list {
    padding-bottom: 24px;
  }
}

.app-drawer__workspace--active{background:var(--i7y-navigation-active);color:var(--i7y-navigation-active-text)}
.workspace-toggle {font-size:11px}
.backend-state {font-size:12px;color:#71717a;display:flex;align-items:center;gap:6px}
.backend-state i {width:6px;height:6px;border-radius:50%;background:var(--i7y-positive-text)}
.language-select {min-width:90px;font-size:12px}
@media(max-width:600px){.backend-state{display:none}.q-toolbar__title{font-size:18px}.language-select{min-width:80px}}
</style>

<style scoped>
.drawer-organization{padding:16px 16px 0}
.app-layout{--app-toolbar-height:50px}
.app-toolbar{min-height:var(--app-toolbar-height)}
.drawer-controls{box-sizing:border-box;height:calc(var(--app-toolbar-height) + 1px);display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid var(--i7y-separator);gap:8px;color:var(--i7y-text)}
.drawer-controls .language-select{width:58px;min-width:58px;font-size:12px}
.drawer-controls .backend-state{display:flex;color:var(--i7y-muted);font-size:11px;gap:5px}
.drawer-controls .backend-state i{width:6px;height:6px;border-radius:50%;background:var(--i7y-positive-text)}
.drawer-controls .backend-state i.offline{background:#ef4444}
.drawer-controls .backend-state i.pending{background:#f59e0b}
</style>

<style scoped>
.drawer-shell{height:100%;display:flex;flex-direction:column;overflow:hidden}
.drawer-controls,.drawer-organization,.drawer-navigation{flex:none}
.drawer-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.drawer-navigation{padding-bottom:0}
.drawer-workspaces{flex:1;min-height:0;display:flex;flex-direction:column}
.drawer-workspaces>.q-item__label,.drawer-workspaces>.q-px-md{flex:none}
.workspace-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable;padding-bottom:16px}
.workspace-scroll:focus-visible{outline:2px solid var(--q-primary);outline-offset:-2px}
.workspace-scroll,.drawer-body{scrollbar-width:thin;scrollbar-color:var(--i7y-muted) transparent}
.workspace-scroll::-webkit-scrollbar,.drawer-body::-webkit-scrollbar{width:6px}
.workspace-scroll::-webkit-scrollbar-track,.drawer-body::-webkit-scrollbar-track{background:transparent}
.workspace-scroll::-webkit-scrollbar-thumb,.drawer-body::-webkit-scrollbar-thumb{background:var(--i7y-muted);border-radius:6px}
@media(max-height:639px){.drawer-body{overflow-y:auto;overscroll-behavior:contain}.drawer-workspaces{flex:none;min-height:auto}.workspace-scroll{flex:none;overflow:visible;scrollbar-gutter:auto}}
</style>
<style>
.app-drawer{overflow:hidden}
</style>
