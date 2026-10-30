import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../apps/backend/hooks/lib/alerts.js', import.meta.url), 'utf8')
const fixtureSource = readFileSync(new URL('./alerts-engine.test.js', import.meta.url), 'utf8')
const start = Date.parse('2026-10-28T12:00:00Z')
const fixture = vm.runInNewContext('(' + fixtureSource.slice(fixtureSource.indexOf('function fixture()'), fixtureSource.indexOf('\ntest(')) + ')', { source, vm, assert, start })
const memory = usage => ({ memory_total_bytes: 1000000, memory_available_bytes: typeof usage === 'number' ? 1000000 - Math.round(usage * 10000) : usage })
const draft = (overrides = {}) => ({ name: 'Memory usage', severity: 'warning', scope_type: 'server', scope_id: 'server', duration_seconds: 300, reminder_seconds: 900, condition: { metric: 'host.memory_percent', operator: 'gt', value: 80, critical_value: 90 }, ...overrides })
function setup(overrides = {}) {
  const f = fixture()
  const rule = f.engine.saveRule(f.app, 'org', 'memory-usage', draft(overrides), 'user', start)
  const send = (at, usage, now = at, overrides = {}) => f.send(f.snapshot(start + at, { host: memory(usage), ...overrides }), start + now)
  return { ...f, rule, send, state: () => f.value(f.all('alert_states')[0], 'data'), feed: at => f.engine.validNotifications(f.app, 'org', 0, 100, start + at).items }
}

test('memory explicitly supports validated escalating thresholds without widening unrelated metrics', () => {
  const f = fixture()
  assert.equal(f.engine.catalog().find(metric => metric.id === 'host.memory_percent').supports_critical_value, true)
  assert.equal(f.engine.normalizeRule(draft()).condition.critical_value, 90)
  for (const critical_value of [80, 100.01, null, '90', NaN, Infinity]) assert.throws(() => f.engine.normalizeRule(draft({ condition: { metric: 'host.memory_percent', operator: 'gt', value: 80, critical_value } })))
  for (const metric of ['container.cpu_percent', 'container.memory_percent', 'server.no_communication_seconds']) assert.throws(() => f.engine.normalizeRule(draft({ condition: { metric, operator: 'gt', value: 80, critical_value: 90 } })))
  for (const operator of ['lt', 'lte', 'eq', 'ne']) assert.throws(() => f.engine.normalizeRule(draft({ condition: { metric: 'host.memory_percent', operator, value: 80, critical_value: 90 } })))
  for (const severity of ['info', 'critical']) assert.throws(() => f.engine.normalizeRule(draft({ severity })))
})

test('80 and 90 boundaries and initial critical require the full entry duration', () => {
  for (const [usage, severity] of [[80, null], [80.0001, 'warning'], [90, 'warning'], [90.0001, 'critical']]) {
    const f = setup()
    f.send(1000, usage)
    f.send(300999, usage)
    assert.equal(f.open().length, 0)
    f.send(301000, usage)
    assert.equal(f.open().length, severity ? 1 : 0)
    if (severity) assert.equal(f.open()[0].get('severity'), severity)
  }
  for (const [usage, severity] of [[80, 'warning'], [90, 'critical']]) {
    const f = setup({ condition: { metric: 'host.memory_percent', operator: 'gte', value: 80, critical_value: 90 } })
    f.send(1000, usage)
    f.send(301000, usage)
    assert.equal(f.open()[0].get('severity'), severity)
  }
})

test('warning and renewed critical entries have independent clocks on the same occurrence', () => {
  const f = setup()
  f.send(1000, 85)
  f.send(301000, 85)
  const incident = f.open()[0], id = incident.id, opened = incident.get('opened_at')
  f.send(302000, 95)
  assert.equal(incident.get('severity'), 'warning')
  assert.equal(incident.get('version'), 1)
  f.send(601999, 95)
  assert.equal(incident.get('severity'), 'warning')
  f.send(602000, 95)
  assert.equal(incident.get('severity'), 'critical')
  assert.equal(incident.get('version'), 2)
  assert.equal(f.feed(602000)[0].severity, 'critical')
  f.send(603000, 90)
  assert.equal(incident.get('severity'), 'warning')
  assert.equal(incident.get('version'), 3)
  assert.equal(f.state().critical_pending_since, null)
  f.send(604000, 95)
  f.send(903999, 95)
  assert.equal(incident.get('severity'), 'warning')
  f.send(904000, 95)
  assert.equal(incident.get('severity'), 'critical')
  assert.equal(incident.get('version'), 4)
  f.send(905000, 80)
  assert.equal(incident.get('status'), 'resolved')
  assert.equal(incident.get('version'), 5)
  assert.equal(f.all('incidents').length, 1)
  assert.equal(incident.id, id)
  assert.equal(incident.get('opened_at'), opened)
  assert.equal(f.all('incident_events').filter(event => event.get('kind') === 'severity_changed').length, 3)
})

test('a fresh warning-band reading resets critical confirmation while warning duration continues', () => {
  const f = setup()
  f.send(1000, 95)
  f.send(201000, 90)
  assert.equal(f.state().critical_pending_since, null)
  f.send(301000, 95)
  assert.equal(f.open()[0].get('severity'), 'warning')
  assert.equal(f.state().critical_pending_since, start + 301000)
  f.send(601000, 95)
  assert.equal(f.open()[0].get('severity'), 'critical')
})

test('unknown, invalid and complete missing memory reset confirmation without demoting active incidents', () => {
  for (const usage of [null, -1, '95', NaN, undefined]) {
    const f = setup()
    f.send(1000, 85)
    f.send(301000, 85)
    const incident = f.open()[0]
    f.send(302000, 95)
    f.send(402000, usage)
    assert.equal(f.state().critical_pending_since, null)
    assert.equal(incident.get('severity'), 'warning')
    f.send(502000, 95)
    f.send(801999, 95)
    assert.equal(incident.get('severity'), 'warning')
    f.send(802000, 95)
    assert.equal(incident.get('severity'), 'critical')
    f.send(902000, null)
    assert.equal(incident.get('severity'), 'critical')
    assert.equal(incident.get('status'), 'open')
    f.send(1002000, 95)
    assert.equal(incident.get('severity'), 'critical')
    assert.equal(incident.get('version'), 2)
  }
})

test('unrelated event-only memory omissions neither reset nor advance either confirmation clock', () => {
  const f = setup()
  f.send(1000, 95)
  f.send(101000, undefined, 101000, { metrics_complete: false, host: {} })
  assert.equal(f.state().pending_since, start + 1000)
  assert.equal(f.state().critical_pending_since, start + 1000)
  assert.equal(f.state().last_usable, start + 1000)
  f.send(301000, undefined, 301000, { metrics_complete: false, host: {} })
  assert.equal(f.open().length, 0)
  f.send(301000, 95)
  assert.equal(f.open()[0].get('severity'), 'critical')
  const g = setup()
  g.send(1000, 85)
  g.send(301000, 85)
  g.send(302000, 95)
  g.send(402000, undefined, 402000, { metrics_complete: false, host: {} })
  assert.equal(g.state().critical_pending_since, start + 302000)
  g.send(602000, 95)
  assert.equal(g.open()[0].get('severity'), 'critical')
})

test('usable gaps reset critical confirmation without recovery or demotion', () => {
  const f = setup()
  f.send(1000, 85)
  f.send(301000, 85)
  const incident = f.open()[0]
  f.send(302000, 95)
  f.send(600000, undefined, 600000, { metrics_complete: false, host: {} })
  assert.equal(f.state().last_usable, start + 302000)
  f.send(903001, 95)
  assert.equal(incident.get('severity'), 'warning')
  assert.equal(f.state().critical_pending_since, start + 903001)
  f.send(1203001, 95)
  assert.equal(incident.get('severity'), 'critical')
  f.send(1804002, 95)
  assert.equal(incident.get('severity'), 'critical')
  assert.equal(incident.get('status'), 'open')
})

test('duplicates, out-of-order and stale samples neither reset nor advance critical confirmation', () => {
  const f = setup()
  f.send(1000, 85)
  f.send(301000, 85)
  f.send(302000, 95)
  const pending = f.state().critical_pending_since
  f.send(301500, 80)
  f.send(302000, 85)
  assert.equal(f.state().critical_pending_since, pending)
  f.send(601999, 95)
  assert.equal(f.open()[0].get('severity'), 'warning')
  f.send(602000, 95)
  assert.equal(f.open()[0].get('severity'), 'critical')
  f.send(603000, 80, 1504000)
  assert.equal(f.open()[0].get('severity'), 'critical')
  assert.equal(f.open()[0].get('status'), 'open')
  assert.equal(f.state().last_raw, start + 602000)
})

test('future timestamps are capped to receipt time for both confirmation clocks', () => {
  const f = setup()
  f.send(301000, 95, 1000)
  f.send(302000, 95, 2000)
  assert.equal(f.open().length, 0)
  assert.equal(f.state().critical_pending_since, start + 1000)
  f.send(601000, 95, 301000)
  assert.equal(f.open()[0].get('severity'), 'critical')
})

test('memory transitions preserve short claims, versions and nonduplicated reminder deadlines', () => {
  const f = setup()
  f.send(1000, 85)
  f.send(301000, 85)
  const incident = f.open()[0], deadline = new Date(start + 603000).toISOString()
  f.engine.claim(f.app, incident, 'alice', deadline, 1, start + 301500)
  f.send(302000, 95)
  f.send(602000, 95)
  assert.equal(incident.get('severity'), 'critical')
  assert.equal(incident.get('version'), 3)
  assert.equal(incident.get('assignee'), 'alice')
  assert.equal(incident.get('next_reminder_at'), deadline)
  assert.equal(f.feed(602000).length, 0)
  assert.throws(() => f.engine.claim(f.app, incident, 'alice', deadline, 2, start + 602000), error => error.code === 409)
  f.engine.tick(f.app, start + 603000)
  assert.equal(f.feed(603000).length, 1)
  const count = f.all('incident_notifications').length
  f.engine.tick(f.app, start + 603000)
  assert.equal(f.all('incident_notifications').length, count)
  f.send(604000, 90)
  assert.equal(incident.get('severity'), 'warning')
  assert.equal(incident.get('assignee'), 'alice')
  assert.equal(incident.get('claim_until'), deadline)
})

test('legacy memory and nonzero-duration disks retain their original escalation semantics', () => {
  const legacy = setup({ condition: { metric: 'host.memory_percent', operator: 'gt', value: 80 }, severity: 'critical' })
  legacy.send(1000, 85)
  legacy.send(301000, 85)
  assert.equal(legacy.open()[0].get('severity'), 'critical')
  assert.equal('critical_pending_since' in legacy.state(), false)
  const f = fixture(), body = draft({ condition: { metric: 'host.disk_percent', operator: 'gt', value: 80, critical_value: 90 } })
  f.engine.saveRule(f.app, 'org', 'disk-duration', body, 'user', start)
  const send = (at, available_bytes) => f.send(f.snapshot(start + at, { host: { disks: [{ path: '/', total_bytes: 100, available_bytes }] } }))
  send(1000, 15)
  send(301000, 15)
  const incident = f.open()[0]
  assert.equal(incident.get('severity'), 'warning')
  send(302000, 5)
  assert.equal(incident.get('severity'), 'critical')
  assert.equal('critical_pending_since' in f.value(f.all('alert_states')[0], 'data'), false)
})

test('simulation previews instantaneous severity without claiming sustained confirmation', () => {
  const f = fixture(), raw = f.snapshot(start + 1000, { host: memory(95) })
  f.app.findRecordById('servers', 'server').set('telemetry', { observed_at: raw.observed_at })
  f.add('telemetry_samples', 'usage-sample', { server: 'server', observed_at: raw.observed_at, payload: raw })
  const result = f.engine.simulate(f.app, 'org', draft(), start + 1000)
  assert.equal(result.items[0].result, 'true')
  assert.equal(result.items[0].severity, 'critical')
  assert.equal(f.all('alert_states').length, 0)
  assert.equal(f.all('incidents').length, 0)
})

test('memory usage uses total minus available rather than free memory', () => {
  const f = setup({ duration_seconds: 0 })
  f.send(1000, undefined, 1000, { host: { memory_total_bytes: 1000, memory_available_bytes: 150, memory_free_bytes: 0 } })
  const incident = f.open()[0]
  assert.equal(incident.get('severity'), 'warning')
  assert.equal(f.value(incident, 'evidence').value, 85)
  f.send(2000, undefined, 2000, { host: { memory_total_bytes: 1000, memory_available_bytes: 50, memory_free_bytes: 1000 } })
  assert.equal(incident.get('severity'), 'critical')
  assert.equal(f.value(incident, 'evidence').value, 95)
})

test('invalid totals and unavailable or inconsistent availability cannot demote or recover memory incidents', () => {
  const invalid = [
    {},
    { memory_total_bytes: 0, memory_available_bytes: 0 },
    { memory_total_bytes: -1, memory_available_bytes: 0 },
    { memory_total_bytes: 100, memory_available_bytes: 101 },
    { memory_total_bytes: 100, memory_available_bytes: -1 },
    { memory_total_bytes: 100, memory_available_bytes: null },
    { memory_total_bytes: null, memory_available_bytes: 0 },
    { memory_total_bytes: 100 },
    { memory_available_bytes: 5 },
    { memory_total_bytes: '100', memory_available_bytes: 5 },
    { memory_total_bytes: 100, memory_available_bytes: '5' },
    { memory_total_bytes: Infinity, memory_available_bytes: 5 }
  ]
  for (const host of invalid) {
    const f = setup()
    f.send(1000, 95)
    f.send(301000, 95)
    const incident = f.open()[0]
    f.send(302000, undefined, 302000, { host })
    assert.equal(incident.get('severity'), 'critical')
    assert.equal(incident.get('status'), 'open')
    assert.equal(incident.get('version'), 1)
    assert.equal(f.state().pending_since, null)
    assert.equal(f.state().critical_pending_since, null)
    f.send(303000, 95)
    assert.equal(incident.get('severity'), 'critical')
    assert.equal(incident.get('version'), 1)
    f.send(304000, 85)
    assert.equal(incident.get('severity'), 'warning')
    f.send(305000, 80)
    assert.equal(incident.get('status'), 'resolved')
  }
})

test('partial memory families in event reports are unknown while absent families remain skipped', () => {
  for (const host of [{ memory_total_bytes: 1000000 }, { memory_available_bytes: 50000 }, { memory_total_bytes: null, memory_available_bytes: null }]) {
    const f = setup()
    f.send(1000, 95)
    f.send(201000, undefined, 201000, { metrics_complete: false, host })
    assert.equal(f.state().pending_since, null)
    assert.equal(f.state().critical_pending_since, null)
    f.send(301000, 95)
    assert.equal(f.open().length, 0)
    f.send(601000, 95)
    assert.equal(f.open()[0].get('severity'), 'critical')
  }
})
