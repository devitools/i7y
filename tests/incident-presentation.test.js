import {test} from 'node:test'
import assert from 'node:assert/strict'
import {incidentTargetHref,incidentMetric} from '../apps/web/src/incident-presentation.ts'
import {containerStateText} from '../apps/web/src/telemetry-summary.ts'
test('links inventory targets without inventing external destinations',()=>{
 assert.match(incidentTargetHref({resource_type:'server',server_id:'abcdefghijklmno'}),/^#\/telemetry\?server=abcdefghijklmno/)
 const link=incidentTargetHref({resource_type:'container',server_id:'abcdefghijklmno',resource_name:'worker & queue'})
 assert.match(link,/search=worker\+%26\+queue/)
 assert.match(link,/status=all/)
 assert.equal(incidentTargetHref({resource_type:'external',resource_id:'https://example.com'}),null)
})
test('formats the observation with units, zero and unavailable values',()=>{
 const t=x=>x
 assert.equal(incidentMetric({evidence:{metric:'host.memory_percent',value:90.12}},t,'en'),'90.1%')
 assert.equal(incidentMetric({evidence:{metric:'host.cpu_percent',value:0}},t,'en'),'0%')
 assert.equal(incidentMetric({evidence:{value:null}},t,'en'),'—')
 assert.equal(incidentMetric({evidence:{metric:'container.state',value:'exited'}},t,'en'),'Stopped')
 assert.equal(containerStateText({state:'exited'}),containerStateText({telemetry:{state:'exited'}}))
})
