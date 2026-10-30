export function timestamp(value) {
  if(typeof value==='number')return value
  if(!value)return NaN
  const normalized=value.replace(' ','T')
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(normalized)?normalized:normalized+'Z')
}
export function memoryPercent(host) {
  return host?.memory_total_bytes>0 && Number.isFinite(host.memory_available_bytes)?Math.max(0,Math.min(100,100*(1-host.memory_available_bytes/host.memory_total_bytes))):null
}
export function diskPercent(disk) {
  return disk?.total_bytes>0 && Number.isFinite(disk.available_bytes)?Math.max(0,Math.min(100,100*(1-disk.available_bytes/disk.total_bytes))):null
}
export function containerGroup(record) {
  const data=record.telemetry
  if(!data?.state || data.state==='unknown')return 'unknown'
  return data.state==='running' && !['unhealthy','starting'].includes(data.health)?'running':'attention'
}
export function containerSummary(records) {
  return records.reduce((counts,r)=>{counts[containerGroup(r)]++;return counts},{running:0,attention:0,unknown:0})
}
export function metricSeries(samples,metric,start,end) {
  return samples.map(s=>({time:timestamp(s.observed_at),value:metric==='cpu'?s.payload?.host?.cpu_percent:memoryPercent(s.payload?.host)})).filter(p=>p.time>=start && p.time<=end && Number.isFinite(p.value)).sort((a,b)=>a.time-b.time)
}
export function plotSeries(points,start,end) {
  let previous=null
  return points.map(p=>{const x=48+(p.time-start)/Math.max(1,end-start)*720,y=174-Math.max(0,Math.min(100,p.value))*1.4;const next={...p,x,y,move:previous===null || p.time-previous>900000};previous=p.time;return next})
}

export function telemetrySince(days,now=Date.now()) {
  return new Date(now-days*86400000).toISOString().replace('T',' ')
}

export function serverStats(telemetry,containers,now=Date.now()) {
  const disks=(telemetry?.host?.disks || []).map(diskPercent).filter(Number.isFinite)
  const os=telemetry?.host?.operating_system
  const operatingSystem=os?(os.pretty_name || [os.name,os.version_id].filter(Boolean).join(' ')):''
  const operatingSystemDetails=os?[operatingSystem,os.architecture,os.kernel].filter(Boolean).join(' · '):''
  const lastAccess=timestamp(telemetry?.host?.last_rdp_access_at)
  const windows=os?.family==='windows' || telemetry?.host?.os==='windows'
  const rdpActive=telemetry?.host?.rdp_session_active
  const rdpAccessDays=Number.isFinite(lastAccess) && lastAccess<=now?Math.floor((now-lastAccess)/86400000):null
  return {windows,rdpActive,rdpAccessDays,lastRdpAccessAt:telemetry?.host?.last_rdp_access_at || null,operatingSystem,operatingSystemDetails,hostOnly:telemetry?.collection_mode==='host',observedAt:telemetry?.observed_at || null,stale:!!telemetry?.observed_at && now-timestamp(telemetry.observed_at)>900000,cpu:Number.isFinite(telemetry?.host?.cpu_percent)?telemetry.host.cpu_percent:null,memory:memoryPercent(telemetry?.host),disk:disks.length?Math.max(...disks):null,healthy:containerSummary(containers).running,total:containers.length}
}

export function containerStateText(record) {
  const state = record.state || record.telemetry?.state || 'unknown'
  return ({missing:'Removed',removed:'Removed',running:record.telemetry?.health==='unhealthy'?'Unhealthy':record.telemetry?.health==='starting'?'Starting':'Running',exited:'Stopped',dead:'Dead',paused:'Paused',restarting:'Restarting',created:'Created',removing:'Removing'})[state] || 'Unknown'
}
