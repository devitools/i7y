import test from 'node:test'
import assert from 'node:assert/strict'
import {incidentServerHref} from '../apps/web/src/incident-presentation.ts'

test('Server incidents and container incidents lead to their server controls',()=>{
  assert.equal(incidentServerHref({resource_type:'server',resource_id:'a'.repeat(15)}),'#/telemetry?server=aaaaaaaaaaaaaaa')
  assert.equal(incidentServerHref({resource_type:'container',resource_id:'b'.repeat(15),server_id:'c'.repeat(15)}),'#/telemetry?server=ccccccccccccccc')
  assert.equal(incidentServerHref({resource_type:'server',resource_id:'javascript:alert(1)'}),null)
  assert.equal(incidentServerHref(null),null)
})
