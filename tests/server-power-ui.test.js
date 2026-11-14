import test from 'node:test'
import assert from 'node:assert/strict'
import {incidentServerHref} from '../apps/web/src/incident-presentation.ts'
import {selectPowerResult,presentPowerResult} from '../apps/web/src/server-power-presentation.ts'

test('Server incidents and container incidents lead to their server controls',()=>{
  assert.equal(incidentServerHref({resource_type:'server',resource_id:'a'.repeat(15)}),'#/telemetry?server=aaaaaaaaaaaaaaa')
  assert.equal(incidentServerHref({resource_type:'container',resource_id:'b'.repeat(15),server_id:'c'.repeat(15)}),'#/telemetry?server=ccccccccccccccc')
  assert.equal(incidentServerHref({resource_type:'server',resource_id:'javascript:alert(1)'}),null)
  assert.equal(incidentServerHref(null),null)
})

test('power on and a pending disk unlock never claim startup success',()=>{
  const pending={action:'start',status:'requires_console',stage:'requires_console',reason:'boot_unavailable'}
  const view=presentPowerResult(pending,false)
  assert.equal(view.tone,'warning')
  assert.equal(view.title,'power.result.pendingUnlock')
  assert.equal(view.detail,'power.result.unlockNotConfigured')
  assert.equal(view.console,true)
  assert.notEqual(presentPowerResult({...pending,status:'awaiting_agent',stage:'awaiting_agent'},true).tone,'positive')
  assert.notEqual(presentPowerResult({action:'inspect',status:'observed',stage:'provider_on'},false).tone,'positive')
})

test('startup succeeds only after recovery is confirmed, without a stale error',()=>{
  const view=presentPowerResult({action:'start',status:'recovered',stage:'agent_connected',reason:'boot_unavailable'},false)
  assert.equal(view.tone,'positive')
  assert.equal(view.title,'power.result.ready')
  assert.equal(view.detail,'power.result.readyHelp')
  assert.equal(view.console,false)
})

test('power inspections preserve the pending startup while off observations supersede it',()=>{
  const pending={action:'start',status:'requires_console',stage:'requires_console'}
  const on={action:'inspect',status:'observed',stage:'provider_on'}
  assert.equal(selectPowerResult([on,pending]),pending)
  const off={...on,stage:'provider_off'}
  assert.equal(selectPowerResult([off,pending]),off)
  const shutdown={action:'shutdown',status:'powered_off',stage:'powered_off'}
  assert.equal(selectPowerResult([on,shutdown,pending]),on)
})

test('unknown operations and real credential failures retain distinct outcomes',()=>{
  const unknown={action:'start',status:'unknown',stage:'unknown',reason:'provider_unavailable'}
  assert.equal(selectPowerResult([{action:'inspect',status:'observed',stage:'provider_on'},unknown]),unknown)
  assert.equal(presentPowerResult(unknown,false).tone,'warning')
  assert.equal(presentPowerResult({action:'start',status:'failed',stage:'failed',reason:'vault_unavailable'},false).tone,'negative')
})
