<script setup lang="ts">
import { computed } from 'vue'
import { activeOrganization, organizationChoices, connectionRevision, connectedSources } from '../api'
import { activeConnectionId, desktopRuntime } from '../desktop-backend'
import { dark } from '../theme'
import { t } from '../i18n'
const emit=defineEmits(['select'])
const options=computed(()=>{
  connectionRevision.value
  if(!desktopRuntime)return organizationChoices.value.map(org=>({label:org.name,value:JSON.stringify(['browser',org.id])}))
  return connectedSources().flatMap(source=>[{label:source.name,value:'header:'+source.id,header:true,disable:true},...source.organizations.map(org=>({label:org.name,value:JSON.stringify([source.id,org.id])}))])
})
const selected=computed(()=>{const value=JSON.stringify([desktopRuntime?activeConnectionId.value:'browser',activeOrganization.value]);return options.value.some(option=>option.value===value)?value:null})
function select(value:string){const [connection,organization]=JSON.parse(value);emit('select',connection,organization)}
</script>
<template><q-select :model-value="selected" @update:model-value="select" :options="options" emit-value map-options outlined dense :dark="dark" :label="t('Organization')"><template #option="scope"><q-item v-bind="scope.itemProps"><q-item-section><q-item-label :class="scope.opt.header?'text-weight-bold text-caption':''">{{scope.opt.label}}</q-item-label></q-item-section></q-item></template></q-select></template>
