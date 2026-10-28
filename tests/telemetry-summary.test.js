import test from 'node:test'
import assert from 'node:assert/strict'
import {telemetrySince,timestamp,memoryPercent,diskPercent,containerSummary,metricSeries,plotSeries} from '../apps/web/src/telemetry-summary.js'
test('timestamps use UTC and missing metrics remain unknown',()=>{
 assert.equal(timestamp('2026-10-23 12:00:00.000Z'),Date.parse('2026-10-23T12:00:00Z'))
 assert.equal(timestamp('2026-10-23 12:00:00'),Date.parse('2026-10-23T12:00:00Z'))
 assert.equal(memoryPercent({memory_total_bytes:100,memory_available_bytes:30}),70)
 assert.equal(memoryPercent({memory_total_bytes:0,memory_available_bytes:0}),null)
 assert.equal(memoryPercent({}),null)
 assert.equal(diskPercent({total_bytes:100,available_bytes:10}),90)
 assert.equal(diskPercent({total_bytes:0}),null)
})
test('container health distinguishes unknown telemetry, stopped and unhealthy',()=>{
 const records=[{},...['running','exited','missing'].map(state=>({telemetry:{state}})),{telemetry:{state:'running',health:'unhealthy'}}]
 assert.deepEqual(containerSummary(records),{running:1,attention:3,unknown:1})
 assert.deepEqual(containerSummary([]),{running:0,attention:0,unknown:0})
})
test('trends exclude missing/out-of-range points and break at collection gaps',()=>{
 const samples=[{observed_at:0,payload:{host:{cpu_percent:0}}},{observed_at:300000,payload:{host:{cpu_percent:100}}},{observed_at:600000,payload:{host:{}}},{observed_at:1800000,payload:{host:{cpu_percent:60}}}]
 const points=metricSeries(samples,'cpu',0,1800000)
 assert.deepEqual(points.map(p=>p.value),[0,100,60])
 assert.deepEqual(plotSeries(points,0,1800000).map(p=>p.move),[true,false,true])
 assert.equal(metricSeries(samples,'memory',0,1800000).length,0)
 assert.equal(plotSeries(points,0,1800000)[1].y,34)
})

test('history filters use the PocketBase UTC date format',()=>{
 assert.equal(telemetrySince(.25,Date.parse('2026-10-23T18:00:00Z')),'2026-10-23 12:00:00.000Z')
})

test('server list stats reuse health rules and mark stale samples',async()=>{
 const {serverStats}=await import('../apps/web/src/telemetry-summary.js')
 const now=Date.parse('2026-10-27T12:00:00Z')
 const stats=serverStats({observed_at:'2026-10-27 11:00:00Z',host:{cpu_percent:2,memory_total_bytes:100,memory_available_bytes:60,disks:[{total_bytes:100,available_bytes:80},{total_bytes:100,available_bytes:10}]}},[{telemetry:{state:'running'}},{telemetry:{state:'running',health:'unhealthy'}}],now)
 assert.equal(stats.cpu,2);assert.equal(stats.memory,40);assert.equal(stats.disk,90)
 assert.equal(stats.healthy,1);assert.equal(stats.total,2);assert.equal(stats.stale,true)
 const empty=serverStats(null,[],now)
 assert.equal(empty.observedAt,null);assert.equal(empty.cpu,null);assert.equal(empty.stale,false)
})

test('server stats expose collected OS details and support older agents',async()=>{
 const {serverStats}=await import('../apps/web/src/telemetry-summary.js')
 const stats=serverStats({host:{operating_system:{pretty_name:'Ubuntu 24.04.3 LTS',architecture:'amd64',kernel:'6.8.0'}}},[])
 assert.equal(stats.operatingSystem,'Ubuntu 24.04.3 LTS')
 assert.equal(stats.operatingSystemDetails,'Ubuntu 24.04.3 LTS · amd64 · 6.8.0')
 assert.equal(serverStats({host:{operating_system:{name:'Windows Server',version_id:'2022'}}},[]).operatingSystem,'Windows Server 2022')
 assert.equal(serverStats(null,[]).operatingSystem,'')
})
