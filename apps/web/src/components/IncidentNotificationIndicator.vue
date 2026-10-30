<script setup lang="ts">
defineProps<{visible:boolean, count:number, unavailable:boolean, label:string}>()
</script>
<template><q-btn v-if="visible" flat round :icon="unavailable?'notifications_off':'notifications_none'" :aria-label="label" href="#/incidents"><q-badge v-if="count" color="negative" floating>{{count>99?'99+':count}}</q-badge><q-tooltip>{{label}}</q-tooltip></q-btn></template>
