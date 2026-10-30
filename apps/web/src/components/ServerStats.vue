<script setup lang="ts">
import {computed} from 'vue'
import {t,locale} from '../i18n'
import {metricLevel} from '../metric-scale'
const props=defineProps({server:{type:Object,required:true}})
const stats=computed(()=>props.server.stats)
const pct=value=>Number.isFinite(value)?value.toFixed(1)+'%':'—'
const metrics=computed(()=>[
 ...[{key:'cpu',label:'CPU',percent:stats.value?.cpu},{key:'memory',label:t('Memory'),percent:stats.value?.memory},{key:'disk',label:t('Disk usage'),percent:stats.value?.disk}].map(metric=>({...metric,value:pct(metric.percent)})),
 ...(stats.value?.windows?[{key:'rdp',label:t('Last access'),value:stats.value?.stale?t('Unknown'):stats.value?.rdpActive===true?t('Session active'):stats.value?.rdpAccessDays!==null?stats.value.rdpAccessDays===0?t('Today'):`${stats.value.rdpAccessDays} ${t('days ago')}`:t('Unknown'),percent:null}]:[]),
 ...(stats.value?.hostOnly?[]:[{key:'containers',label:t('Containers'),value:`${stats.value?.healthy} / ${stats.value?.total}`,percent:stats.value?.total>0?stats.value.healthy/stats.value.total*100:null}])
])
const fill=value=>Number.isFinite(value)?Math.max(0,Math.min(100,value)):0
</script>
<template>
 <span v-if="server.type!=='VPS'" class="text-grey-6">{{t('Not applicable')}}</span>
 <div v-else class="server-stats">
  <template v-if="stats?.observedAt"><div class="server-stats-metrics" :class="{'server-stats-stale':stats.stale}"><div v-for="metric in metrics" :key="metric.label" class="server-stat"><q-icon v-if="metric.key==='rdp'" name="history" size="18px" class="text-grey-6"/><span v-else class="stat-gauge" role="meter" :aria-label="metric.label" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Number.isFinite(metric.percent)?fill(metric.percent):undefined" :aria-valuetext="`${metric.value} · ${t(metricLevel(metric.key,metric.percent,{stale:stats.stale}).label)}`"><span :style="{height:fill(metric.percent)+'%',backgroundColor:metricLevel(metric.key,metric.percent,{stale:stats.stale}).color}"/></span><div><small>{{metric.label}}</small><strong>{{metric.value}}</strong></div></div></div><small v-if="stats.stale" class="text-warning">{{t('No communication')}}</small><q-tooltip :delay="600" :hide-delay="0"><div v-if="stats.operatingSystemDetails">{{stats.operatingSystemDetails}}</div><div v-for="metric in metrics" :key="metric.key">{{metric.key==='rdp'?t('Last RDP access'):metric.label}}: {{metric.value}} · {{metric.key==='rdp'?(stats.lastRdpAccessAt?new Date(stats.lastRdpAccessAt).toLocaleString(locale):t('Unknown')):t(metricLevel(metric.key,metric.percent,{stale:stats.stale}).label)}}</div>{{t('Collected at')}}: {{new Date(stats.observedAt.replace(' ','T')).toLocaleString(locale)}}</q-tooltip></template>
  <span v-else class="text-grey-6">{{t(server.statsError?'Unable to load telemetry':'No telemetry')}}</span>
 </div>
</template>
<style scoped>
.server-stats{display:block;color:inherit;text-decoration:none;min-width:270px}.server-stats-os{font-size:11px;line-height:1.4;margin-bottom:5px;max-width:310px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#71717a}.body--dark .server-stats-os{color:#a1a1aa}.server-stats-metrics{display:grid;grid-template-columns:repeat(4,minmax(55px,auto));gap:12px}.server-stats-metrics small{display:block;font-size:10px;color:#71717a;line-height:1.5}.server-stats-metrics strong{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}.server-stat{display:flex;align-items:center;gap:7px}.stat-gauge{display:flex;align-items:flex-end;flex:none;width:12px;height:30px;border-radius:3px;overflow:hidden;background:rgba(127,127,127,.18);box-shadow:inset 0 0 0 1px rgba(127,127,127,.12)}.stat-gauge>span{display:block;width:100%;transition:height .2s ease}.server-stats-stale{opacity:.65}.server-stats>small{font-size:10px}.body--dark .server-stats-metrics small{color:#a1a1aa}
</style>
