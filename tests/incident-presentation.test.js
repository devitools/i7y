import {test} from 'node:test'
import assert from 'node:assert/strict'
import {incidentTargetHref,incidentMetric,incidentSourceUrl} from '../apps/web/src/incident-presentation.ts'
import {containerStateText} from '../apps/web/src/telemetry-summary.ts'
test('links inventory targets without inventing external destinations',()=>{
 assert.match(incidentTargetHref({resource_type:'server',server_id:'abcdefghijklmno'}),/^#\/telemetry\?server=abcdefghijklmno/)
 const link=incidentTargetHref({resource_type:'container',server_id:'abcdefghijklmno',resource_name:'worker & queue'})
 assert.match(link,/search=worker\+%26\+queue/)
 assert.match(link,/status=all/)
 assert.equal(incidentTargetHref({resource_type:'external',resource_id:'https://example.com'}),null)
})
test('only exposes Google Cloud incident links for GCP incidents',()=>{
 const url='https://console.cloud.google.com/monitoring/alerting/alerts/0.example?project=lead-2024'
 assert.equal(incidentSourceUrl({origin:'gcp',evidence:{url}}),url)
 for(const value of ['javascript:alert(1)','https://console.cloud.google.com.evil.example/','https://user@console.cloud.google.com/','http://console.cloud.google.com/','not a url']) assert.equal(incidentSourceUrl({origin:'gcp',evidence:{url:value}}),null)
 assert.equal(incidentSourceUrl({origin:'api',evidence:{url}}),null)
 assert.equal(incidentSourceUrl({origin:'gcp'}),null)
})
test('formats the observation with units, zero and unavailable values',()=>{
 const t=x=>x
 assert.equal(incidentMetric({evidence:{metric:'host.memory_percent',value:90.12}},t,'en'),'90.1%')
 assert.equal(incidentMetric({evidence:{metric:'host.cpu_percent',value:0}},t,'en'),'0%')
 assert.equal(incidentMetric({evidence:{value:null}},t,'en'),'—')
 assert.equal(incidentMetric({evidence:{metric:'container.state',value:'exited'}},t,'en'),'Stopped')
 assert.equal(containerStateText({state:'exited'}),containerStateText({telemetry:{state:'exited'}}))
})
