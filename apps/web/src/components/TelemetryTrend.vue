<script setup lang="ts">
import { computed, ref } from 'vue'
import { metricSeries, plotSeries } from '../telemetry-summary'
import { t, locale } from '../i18n'
const props=defineProps({samples:Array,metric:String,start:Number,end:Number,label:String,color:String})
const hovered=ref(null)
const points=computed(()=>plotSeries(metricSeries(props.samples,props.metric,props.start,props.end),props.start,props.end))
const path=computed(()=>points.value.map(p=>`${p.move?'M':'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '))
const isolated=computed(()=>points.value.filter((p,i)=>p.move && (!points.value[i+1] || points.value[i+1].move)))
const peak=computed(()=>points.value.length?Math.max(...points.value.map(p=>p.value)):null)
const average=computed(()=>points.value.length?points.value.reduce((n,p)=>n+p.value,0)/points.value.length:null)
const format=value=>value===null?'—':value.toFixed(1)+'%'
const time=value=>new Date(value).toLocaleString(locale.value,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})
function inspect(event){const box=event.currentTarget.getBoundingClientRect(),x=(event.clientX-box.left)/box.width*800;hovered.value=points.value.reduce((best,p)=>!best || Math.abs(p.x-x)<Math.abs(best.x-x)?p:best,null)}
</script>
<template>
<section class="trend-panel">
 <div class="trend-title"><h3><i :style="{background:color}"/>{{label}}</h3><span>{{t('Average')}} <strong>{{format(average)}}</strong><span class="q-ml-md">{{t('Peak')}} <strong>{{format(peak)}}</strong></span></span></div>
 <div v-if="points.length" class="trend-plot">
  <svg viewBox="0 0 800 210" role="img" :aria-label="label+' · '+t('Resource history')" @mousemove="inspect" @mouseleave="hovered=null">
   <g v-for="value in [0,50,100]" :key="value"><line x1="48" :y1="174-value*1.4" x2="768" :y2="174-value*1.4" stroke="currentColor" opacity=".09"/><text x="44" :y="178-value*1.4" text-anchor="end" fill="currentColor" opacity=".55" font-size="16">{{value}}%</text></g>
   <path :d="path" fill="none" :stroke="color" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
   <circle v-for="point in isolated" :key="point.time" :cx="point.x" :cy="point.y" r="3" :fill="color"/>
   <g v-if="hovered"><line :x1="hovered.x" y1="24" :x2="hovered.x" y2="174" stroke="currentColor" opacity=".25" stroke-dasharray="3 3"/><circle :cx="hovered.x" :cy="hovered.y" r="4" :fill="color"/></g>
   <text x="48" y="203" fill="currentColor" opacity=".55" font-size="16">{{time(start)}}</text><text x="768" y="203" text-anchor="end" fill="currentColor" opacity=".55" font-size="16">{{time(end)}}</text>
  </svg>
  <div class="trend-readout" aria-live="polite">{{hovered ? time(hovered.time)+' · '+format(hovered.value) : t('Hover to inspect a sample')}}</div>
 </div>
 <div v-else class="trend-empty"><q-icon name="show_chart" size="28px"/><p>{{t('No telemetry in this period')}}</p></div>
</section>
</template>
<style scoped>
.trend-panel{min-width:0}.trend-title{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:20px 20px 0}.trend-title h3{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;margin:0}.trend-title i{width:8px;height:8px;border-radius:50%}.trend-title>span{font-size:11px;color:#71717a}.trend-title strong{color:inherit;font-weight:600}.trend-plot svg{display:block;width:100%;height:auto}.trend-readout{text-align:center;min-height:30px;font-size:11px;color:#71717a}.trend-empty{min-height:200px;display:flex;align-items:center;justify-content:center;flex-direction:column;color:#a1a1aa;font-size:12px}.body--dark .trend-title>span,.body--dark .trend-readout{color:#a1a1aa}
</style>
