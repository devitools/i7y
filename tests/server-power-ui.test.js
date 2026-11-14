import test from 'node:test'
import assert from 'node:assert/strict'
import {incidentServerHref} from '../apps/web/src/incident-presentation.ts'
import {selectPowerResult,presentPowerResult} from '../apps/web/src/server-power-presentation.ts'
import {materialSymbol} from '../apps/web/src/icons.ts'

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

test('a new inspection never reuses the success or timestamp of an older startup',()=>{
  const recovered={action:'start',status:'recovered',stage:'agent_connected',updated:'2026-11-14T06:58:08Z'}
  const on={action:'inspect',status:'observed',stage:'provider_on',updated:'2026-11-14T07:08:14Z'}
  const result=selectPowerResult([on,recovered])
  assert.equal(result,on)
  assert.equal(result.updated,on.updated)
  assert.equal(presentPowerResult(result,true).tone,'info')
  assert.equal(presentPowerResult(result,true).detail,'power.result.providerOnHelp')
  const locked={...on,stage:'disk_locked'}
  assert.equal(selectPowerResult([locked,recovered]),locked)
  const view=presentPowerResult(locked,true)
  assert.equal(view.tone,'warning')
  assert.equal(view.title,'power.result.diskLocked')
  assert.equal(view.console,true)
})

test('unknown operations and real credential failures retain distinct outcomes',()=>{
  const unknown={action:'start',status:'unknown',stage:'unknown',reason:'provider_unavailable'}
  const on={action:'inspect',status:'observed',stage:'provider_on'}
  assert.equal(selectPowerResult([on,unknown]),on)
  assert.equal(presentPowerResult(unknown,false).tone,'warning')
  assert.equal(presentPowerResult({action:'start',status:'failed',stage:'failed',reason:'vault_unavailable'},false).tone,'negative')
})

test('fresh observations remain visible while a running request still takes precedence',()=>{
  const unknown={action:'start',status:'unknown',stage:'unknown'}
  const locked={action:'inspect',status:'observed',stage:'disk_locked'}
  const running={action:'start',status:'running',stage:'waiting_for_boot'}
  assert.equal(selectPowerResult([locked,unknown]),locked)
  assert.equal(selectPowerResult([locked,running]),running)
  assert.equal(selectPowerResult([{...locked,status:'failed',stage:'failed'},unknown]),unknown)
})

test('power result icons resolve to available Material Symbols',()=>{
  for(const icon of ['info_outline','error_outline','help_outline'])assert.equal(materialSymbol(icon).icon,'sym_o_'+icon.replace('_outline',''))
})
