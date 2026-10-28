import test from 'node:test'
import assert from 'node:assert/strict'
import {metricLimits,metricLevels,metricLevel} from '../apps/web/src/metric-scale.ts'
test('resource boundaries advance severity at exact thresholds',()=>{
 for(const [key,limits] of Object.entries(metricLimits)) {
  assert.equal(metricLevel(key,0).label,'Comfortable')
  limits.forEach((v,i)=>{assert.equal(metricLevel(key,v-.01).label,metricLevels[i].label);assert.equal(metricLevel(key,v).label,metricLevels[i+1].label)})
  assert.equal(metricLevel(key,100).label,'Critical')
 }
})
test('healthy container scale is reversed and never green with unhealthy containers',()=>{
 for(const [value,label] of [[100,'Comfortable'],[99.9,'Observe'],[95,'Observe'],[94.9,'High usage'],[80,'High usage'],[79.9,'Critical'],[0,'Critical']])assert.equal(metricLevel('containers',value).label,label)
})
test('missing and stale telemetry have neutral colors',()=>{
 for(const v of [null,undefined,NaN])assert.equal(metricLevel('cpu',v).color,'#9ca3af')
 assert.equal(metricLevel('cpu',99,{stale:true}).color,'#9ca3af')
})
