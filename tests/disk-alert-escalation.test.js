import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../apps/backend/hooks/lib/alerts.js', import.meta.url), 'utf8')
const fixtureSource = readFileSync(new URL('./alerts-engine.test.js', import.meta.url), 'utf8')
const start = Date.parse('2026-10-28T12:00:00Z')
const fixture = vm.runInNewContext('(' + fixtureSource.slice(fixtureSource.indexOf('function fixture()'), fixtureSource.indexOf('\ntest(')) + ')', { source, vm, assert, start })
const draft = (overrides = {}) => ({ name: 'Disk usage', severity: 'warning', scope_type: 'server', scope_id: 'server', duration_seconds: 0, reminder_seconds: 900, condition: { metric: 'host.disk_percent', operator: 'gt', value: 80, critical_value: 90 }, ...overrides })
const disk = (path, usage) => ({ path, total_bytes: 1000000, available_bytes: 1000000 - Math.round(usage * 10000) })
function setup(overrides = {}) {
  const f = fixture()
  const rule = f.engine.saveRule(f.app, 'org', 'disk', draft(overrides), 'user', start)
  const send = (at, disks, now = at, overrides = {}) => f.send(f.snapshot(start + at, { host: { disks }, ...overrides }), start + now)
  return { ...f, rule, send, notices: () => f.all('incident_notifications'), events: () => f.all('incident_events'), feed: at => f.engine.validNotifications(f.app, 'org', 0, 100, start + at).items }
}

test('disk critical thresholds remain upper-band-only, numeric and warning-based alongside CPU support', () => {
  const f = fixture()
  const normalized = f.engine.normalizeRule(draft())
  assert.equal(normalized.condition.critical_value, 90)
  assert.equal(f.engine.normalizeRule(draft({ condition: { metric: 'host.disk_percent', operator: 'gte', value: 80, critical_value: 100 } })).condition.critical_value, 100)
  for (const critical_value of [80, 79, 100.01, '90', null, NaN, Infinity]) assert.throws(() => f.engine.normalizeRule(draft({ condition: { metric: 'host.disk_percent', operator: 'gt', value: 80, critical_value } })))
  for (const metric of ['container.memory_percent', 'container.cpu_percent', 'server.no_communication_seconds']) assert.throws(() => f.engine.normalizeRule(draft({ condition: { metric, operator: 'gt', value: 80, critical_value: 90 } })))
  for (const operator of ['lt', 'lte', 'eq', 'ne']) assert.throws(() => f.engine.normalizeRule(draft({ condition: { metric: 'host.disk_percent', operator, value: 80, critical_value: 90 } })))
  for (const severity of ['info', 'critical']) assert.throws(() => f.engine.normalizeRule(draft({ severity })))
  const catalog = f.engine.catalog()
  assert.equal(catalog.find(metric => metric.id === 'host.disk_percent').supports_critical_value, true)
  assert.equal(catalog.find(metric => metric.id === 'host.cpu_percent').supports_critical_value, true)
  assert.equal(catalog.find(metric => metric.id === 'host.memory_percent').supports_critical_value, true)
  assert.equal(catalog.filter(metric => metric.supports_critical_value).length, 3)
})

test('strict and inclusive thresholds handle exact 80 and 90 boundaries and initial critical', () => {
  for (const [usage, expected] of [[80, null], [80.0001, 'warning'], [90, 'warning'], [90.0001, 'critical']]) {
    const f = setup()
    f.send(1000, [disk('/', usage)])
    assert.equal(f.open().length, expected ? 1 : 0, String(usage))
    if (expected) assert.equal(f.open()[0].get('severity'), expected, String(usage))
  }
  for (const [usage, expected] of [[79.9999, null], [80, 'warning'], [89.9999, 'warning'], [90, 'critical']]) {
    const f = setup({ condition: { metric: 'host.disk_percent', operator: 'gte', value: 80, critical_value: 90 } })
    f.send(1000, [disk('/', usage)])
    assert.equal(f.open().length, expected ? 1 : 0)
    if (expected) assert.equal(f.open()[0].get('severity'), expected)
  }
})

test('one occurrence escalates, demotes and recovers with versioned audits and fresh notices', () => {
  const f = setup()
  f.send(1000, [disk('/', 85)])
  const incident = f.open()[0], id = incident.id, opened = incident.get('opened_at')
  assert.equal(incident.get('version'), 1)
  assert.equal(f.feed(1000)[0].kind, 'opening')
  const opening = f.notices()[0]
  f.send(2000, [disk('/', 95)])
  assert.equal(incident.get('severity'), 'critical')
  assert.equal(incident.get('version'), 2)
  assert.equal(incident.get('schedule_generation'), 2)
  assert.equal(opening.get('valid'), false)
  assert.equal(f.feed(2000)[0].kind, 'reminder')
  assert.equal(f.feed(2000)[0].severity, 'critical')
  assert.throws(() => f.engine.claim(f.app, incident, 'user', new Date(start + 1000000).toISOString(), 1, start + 2000), error => error.code === 409)
  const count = f.notices().length
  f.send(3000, [disk('/', 96)])
  assert.equal(incident.get('version'), 2)
  assert.equal(f.notices().length, count)
  f.send(4000, [disk('/', 90)])
  assert.equal(incident.get('severity'), 'warning')
  assert.equal(incident.get('version'), 3)
  assert.equal(incident.get('schedule_generation'), 3)
  assert.equal(f.feed(4000)[0].severity, 'warning')
  f.send(5000, [disk('/', 80)])
  assert.equal(incident.get('status'), 'resolved')
  assert.equal(incident.get('version'), 4)
  assert.equal(incident.get('schedule_generation'), 4)
  assert.equal(incident.get('resolution_reason'), 'recovered')
  assert.equal(f.feed(5000)[0].kind, 'resolved')
  assert.equal(f.all('incidents').length, 1)
  assert.equal(incident.id, id)
  assert.equal(incident.get('opened_at'), opened)
  const changes = f.events().filter(event => event.get('kind') === 'severity_changed')
  assert.equal(changes.length, 2)
  assert.deepEqual(JSON.parse(changes[0].getString('data')), { from: 'warning', to: 'critical' })
  assert.deepEqual(JSON.parse(changes[1].getString('data')), { from: 'critical', to: 'warning' })
})

test('severity changes preserve claims and suppress reminders until the claimed deadline', () => {
  for (const expires of [10000, 2000000]) {
    const f = setup()
    f.send(1000, [disk('/', 85)])
    const incident = f.open()[0], deadline = new Date(start + expires).toISOString()
    f.engine.claim(f.app, incident, 'alice', deadline, 1, start + 2000)
    assert.equal(f.feed(2000)[0].kind, 'claimed')
    f.send(3000, [disk('/', 95)])
    assert.equal(incident.get('severity'), 'critical')
    assert.equal(incident.get('version'), 3)
    assert.equal(incident.get('next_reminder_at'), deadline)
    assert.equal(f.feed(3000).length, 0)
    f.send(4000, [disk('/', 85)])
    assert.equal(incident.get('severity'), 'warning')
    assert.equal(incident.get('version'), 4)
    assert.equal(incident.get('assignee'), 'alice')
    assert.equal(incident.get('claim_until'), deadline)
    assert.equal(incident.get('next_reminder_at'), deadline)
    f.engine.tick(f.app, start + expires - 1)
    assert.equal(f.feed(expires - 1).length, 0)
    f.engine.tick(f.app, start + expires)
    assert.equal(f.feed(expires).length, 1)
    assert.equal(f.feed(expires)[0].kind, 'reminder')
    assert.equal(f.feed(expires)[0].severity, 'warning')
    assert.equal(f.events().filter(event => event.get('kind') === 'claim_expired').length, 1)
    const notices = f.notices().length, version = incident.get('version')
    f.engine.tick(f.app, start + expires)
    assert.equal(f.notices().length, notices)
    assert.equal(incident.get('version'), version)
    assert.equal(f.all('incidents').length, 1)
  }
  for (const at of [3000, 4000]) {
    const f = setup()
    f.send(1000, [disk('/', 85)])
    const incident = f.open()[0]
    f.engine.claim(f.app, incident, 'alice', new Date(start + 3000).toISOString(), 1, start + 2000)
    f.send(at, [disk('/', 95)])
    assert.equal(incident.get('next_reminder_at'), new Date(start + at + 900000).toISOString())
    assert.equal(f.feed(at).length, 1)
    assert.equal(f.feed(at)[0].kind, 'reminder')
    assert.equal(f.events().filter(event => event.get('kind') === 'claim_expired').length, 1)
    const count = f.notices().length
    f.engine.tick(f.app, start + at)
    assert.equal(f.notices().length, count)
    assert.equal(f.events().filter(event => event.get('kind') === 'claim_expired').length, 1)
  }
})

test('missing critical disks retain critical evidence until those disks are observed below critical', () => {
  const f = setup()
  f.send(1000, [disk('/', 95), disk('/data', 85)])
  const incident = f.open()[0]
  f.send(2000, [disk('/data', 86)])
  assert.equal(incident.get('severity'), 'critical')
  assert.equal(incident.get('version'), 1)
  assert.equal(f.value(incident, 'evidence').affected_disks.length, 2)
  f.send(3000, [disk('/', 50), disk('/data', 86)])
  assert.equal(incident.get('severity'), 'warning')
  assert.equal(incident.get('version'), 2)
  f.send(4000, [disk('/data', 40)])
  assert.equal(incident.get('status'), 'resolved')
  assert.equal(f.all('incidents').length, 1)
})

test('unknown, invalid, stale, skipped, repeated and out-of-order telemetry cannot demote or recover', () => {
  const f = setup()
  f.send(1000, [disk('/', 95), disk('/data', 85)])
  const incident = f.open()[0]
  f.send(2000, [disk('/data', 40)])
  f.send(3000, [{ path: '/', total_bytes: 0, available_bytes: 0 }, disk('/data', 85)])
  f.send(4000, [disk('/', 85), { path: '/invalid', total_bytes: 0, available_bytes: 0 }])
  assert.equal(incident.get('severity'), 'critical')
  f.send(5000, null)
  f.send(6000, [], 6000, { metrics_complete: false, host: {} })
  f.send(500, [disk('/', 40), disk('/data', 40)])
  f.send(5000, [disk('/', 40), disk('/data', 40)])
  f.send(7000, [disk('/', 40), disk('/data', 40)], 1000000)
  assert.equal(incident.get('status'), 'open')
  assert.equal(incident.get('severity'), 'critical')
  assert.equal(incident.get('version'), 1)
  assert.equal(f.notices().length, 1)
  f.send(1001000, [disk('/', 85), disk('/data', 40)])
  assert.equal(incident.get('severity'), 'warning')
  assert.equal(incident.get('version'), 2)
})

test('severity uses the maximum selected disk while legacy rules retain configured severity', () => {
  const f = setup({ condition: { metric: 'host.disk_percent', operator: 'gt', value: 80, critical_value: 90, disk_path: '/selected' } })
  f.send(1000, [disk('/selected', 85), disk('/unselected', 99)])
  assert.equal(f.open()[0].get('severity'), 'warning')
  const g = setup()
  g.send(1000, [disk('/warning', 85), disk('/critical', 95)])
  assert.equal(g.open()[0].get('severity'), 'critical')
  for (const severity of ['warning', 'critical']) {
    const legacy = setup({ severity, condition: { metric: 'host.disk_percent', operator: 'gt', value: 80 } })
    assert.equal('critical_value' in legacy.value(legacy.rule, 'condition'), false)
    legacy.send(1000, [disk('/', 85)])
    legacy.send(2000, [disk('/', 95)])
    assert.equal(legacy.open()[0].get('severity'), severity)
    assert.equal(legacy.open()[0].get('version'), 1)
    assert.equal(legacy.notices().length, 1)
  }
})

test('simulation exposes computed severity from persisted fresh telemetry without writes', () => {
  for (const [usage, expected] of [[80, null], [90, 'warning'], [91, 'critical']]) {
    const f = fixture(), at = start + 1000, raw = f.snapshot(at, { host: { disks: [disk('/', usage)] } })
    f.app.findRecordById('servers', 'server').set('telemetry', { observed_at: raw.observed_at })
    f.add('telemetry_samples', 'disk-sample', { server: 'server', observed_at: raw.observed_at, payload: raw })
    const before = JSON.stringify(['alert_rules', 'alert_states', 'incidents', 'incident_notifications'].map(table => f.all(table)))
    const simulated = f.engine.simulate(f.app, 'org', draft(), at)
    assert.equal(simulated.items[0].severity, expected)
    assert.equal(JSON.stringify(['alert_rules', 'alert_states', 'incidents', 'incident_notifications'].map(table => f.all(table))), before)
    assert.equal(f.engine.simulate(f.app, 'org', draft(), at + 900001).items[0].severity, null)
  }
})
