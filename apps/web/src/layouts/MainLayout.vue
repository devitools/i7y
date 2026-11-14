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
        <template v-for="(section,index) in navSections" :key="index">
          <q-separator v-if="index" class="drawer-section-separator" />
          <q-item-label v-if="section.label" header class="app-drawer__section-label">{{ section.label }}</q-item-label>

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
            <q-item-section class="text-body2"><q-item-label>{{item.name}}</q-item-label></q-item-section>
          </q-item>
        </template>
      </q-list>

      </div>
      </div>
    </q-drawer>

    <q-page-container>
      <slot />
    </q-page-container>

  </q-layout>
</template>

<script setup lang="ts">
import type { NavigationItem } from '../types'
import { computed, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { dark } from '../theme'
import { locale, t, languageOptions } from '../i18n'
const props = defineProps<{nav?: NavigationItem[]; activeView?: string; loading?: boolean; error?: string;}>()
const emit = defineEmits(['navigate'])
const q = useQuasar()
const compactNavigation = computed(() => q.screen.width <= 1023)
const desktopDrawerOpen = ref(true)
const mobileDrawerOpen = ref(false)
const leftDrawerOpen = computed({
  get: () => compactNavigation.value ? mobileDrawerOpen.value : desktopDrawerOpen.value,
  set: value => { if (compactNavigation.value) mobileDrawerOpen.value = value; else desktopDrawerOpen.value = value },
})
watch(compactNavigation, () => { mobileDrawerOpen.value = false })
const navSections = computed(() => {
  const items=props.nav || []
  return [
    {label:t('Inventory'),items:items.filter(item=>item.id!=='incidents')},
    {label:t('Monitoring'),items:items.filter(item=>item.id==='incidents')},
  ].filter(section=>section.items.length)
})
function selectView(id) { emit('navigate',id); if(compactNavigation.value) leftDrawerOpen.value=false }
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
.drawer-controls,.drawer-organization{flex:none}
.drawer-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--i7y-muted) transparent}
.drawer-navigation{padding-bottom:16px}
.drawer-section-separator{margin:12px 16px 4px}
</style>
<style>
.app-drawer{overflow:hidden}
</style>
