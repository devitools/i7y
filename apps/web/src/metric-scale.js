export const metricLimits={cpu:[60,80,90],memory:[70,85,95],disk:[70,80,90]}
export const metricLevels=[{label:'Comfortable',color:'#16a34a'},{label:'Observe',color:'#eab308'},{label:'High usage',color:'#f97316'},{label:'Critical',color:'#dc2626'}]
export function metricLevel(metric,value,{stale=false}={}) {
 if(stale || !Number.isFinite(value))return {label:stale?'No communication':'No telemetry',color:'#9ca3af'}
 const percent=Math.max(0,Math.min(100,value))
 const level=metric==='containers'?(percent===100?0:percent>=95?1:percent>=80?2:3):metricLimits[metric]?.filter(limit=>percent>=limit).length
 return metricLevels[level] || {label:'No telemetry',color:'#9ca3af'}
}
