<script setup lang="ts">
import {t} from '../i18n'
import {metricLimits,metricLevels} from '../metric-scale'
</script>
<template>
 <q-btn flat round dense size="sm" icon="help_outline" :aria-label="t('Metric color scale')" @click.stop><q-menu @click.stop><div class="metric-scale-legend"><strong>{{t('Metric color scale')}}</strong><table><thead><tr><th></th><th v-for="level in metricLevels" :key="level.label"><i :style="{background:level.color}"/>{{t(level.label)}}</th></tr></thead><tbody><tr v-for="(limits,key) in metricLimits" :key="key"><th>{{key==='cpu'?'CPU':t(key==='memory'?'Memory':'Disk usage')}}</th><td>&lt; {{limits[0]}}%</td><td>{{limits[0]}}–&lt;{{limits[1]}}%</td><td>{{limits[1]}}–&lt;{{limits[2]}}%</td><td>≥ {{limits[2]}}%</td></tr><tr><th>{{t('Healthy containers')}}</th><td>100%</td><td>95–&lt;100%</td><td>80–&lt;95%</td><td>&lt;80%</td></tr></tbody></table><p>{{t('Memory excludes reclaimable cache; disk uses the fullest filesystem.')}}</p><p>{{t('Current sample; confirm sustained usage in telemetry.')}}</p><p><i style="background:#9ca3af"/>{{t('No telemetry')}} / {{t('No communication')}}</p></div></q-menu></q-btn>
</template>
<style scoped>
.metric-scale-legend{padding:16px;max-width:min(620px,95vw);overflow-x:auto}.metric-scale-legend table{border-collapse:collapse;margin:12px 0;font-size:12px}.metric-scale-legend th,.metric-scale-legend td{padding:8px;text-align:left;white-space:nowrap;border-bottom:1px solid #8883}.metric-scale-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}.metric-scale-legend p{font-size:12px;white-space:normal;margin:8px 0 0}
</style>
