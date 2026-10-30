import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../apps/backend/hooks/lib/alerts.js', import.meta.url), 'utf8')
const start = Date.parse('2026-10-28T12:00:00Z')
function fixture() {
  let sequence = 0
  class Record {
    constructor(collection) { this.table = collection.name; this.id = 'record-' + (++sequence); this.values = {} }
    set(key, value) { this.values[key] = value }
    get(key) { return this.values[key] }
    getString(key) { const value = this.values[key]; return value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value) }
    getBool(key) { return this.values[key] === true }
  }
  const data = {}, context = { module: { exports: {} }, Record }
  vm.runInNewContext(source, context)
  function evaluateFilter(record, filter, params) {
    if (!filter) return true
    return filter.split(/\s*&&\s*/).every(part => {
      const match = /^(\w+)\s*(=|>|<)\s*(\{:\w+\}|"[^"]*"|true|false|\d+)$/.exec(part)
      assert.ok(match, 'Unsupported fixture filter: ' + part)
      const [, field, operator, raw] = match
      const expected = raw.startsWith('{:') ? params[raw.slice(2, -1)] : raw.startsWith('"') ? raw.slice(1, -1) : raw === 'true' ? true : raw === 'false' ? false : Number(raw)
      const actual = field === 'id' ? record.id : record.get(field)
      return operator === '=' ? actual === expected : operator === '>' ? actual > expected : actual < expected
    })
  }
  const app = {
    findCollectionByNameOrId(name) { return { name } },
    findRecordsByFilter(table, filter, sort, limit, offset, params = {}) {
      let records = (data[table] || []).filter(record => evaluateFilter(record, filter, params))
      if (sort) {
        const direction = sort.startsWith('-') ? -1 : 1, field = sort.replace(/^-/, '')
        records = records.slice().sort((a, b) => a.get(field) === b.get(field) ? 0 : a.get(field) < b.get(field) ? -direction : direction)
      }
      return records.slice(offset || 0, limit ? (offset || 0) + limit : undefined)
    },
    findRecordById(table, id) { const record = (data[table] || []).find(record => record.id === id); if (!record) throw new Error('Missing record: ' + table + '/' + id); return record },
    save(record) {
      if (!data[record.table]) data[record.table] = []
      if (!data[record.table].includes(record)) data[record.table].push(record)
    }
  }
  function add(table, id, values) { const record = new Record({ name: table }); if (id) record.id = id; Object.entries(values).forEach(([key, value]) => record.set(key, value)); app.save(record); return record }
  add('workspaces', 'workspace', { organization: 'org', login: 'workspace' })
  add('servers', 'server', { workspace: 'workspace', name: 'Server' })
  add('projects', 'project', { server: 'server', name: 'Project' })
  add('containers', 'container', { project: 'project', name: 'web' })
  add('server_agents', 'agent', { server: 'server', created: new Date(start).toISOString() })
  const engine = context.module.exports
  const draft = (overrides = {}) => ({ name: 'CPU high', scope_type: 'workspace', scope_id: 'workspace', condition: { metric: 'container.cpu_percent', operator: 'gt', value: 90 }, ...overrides })
  const rule = (overrides = {}, key = 'cpu') => engine.saveRule(app, 'org', key, draft(overrides), 'user', start)
  const snapshot = (at, overrides = {}) => ({ version: 1, sample_id: 'sample-' + at, observed_at: new Date(at).toISOString(), host: { cpu_percent: 95, memory_total_bytes: 100, memory_available_bytes: 5, disks: [{ path: '/', total_bytes: 100, available_bytes: 5 }] }, metrics_complete: true, docker_complete: true, containers: [{ name: 'web', docker_id: 'docker', state: 'running', health: 'healthy', cpu_percent: 95, memory_bytes: 95, memory_limit_bytes: 100 }], ...overrides })
  const send = (raw, now = Date.parse(raw.observed_at), reconciliation = { applied: true, containers: { web: 'container' }, missing: [] }) => engine.evaluateSnapshot(app, 'server', raw, reconciliation, now)
  const all = table => data[table] || []
  const open = () => all('incidents').filter(record => record.get('status') === 'open')
  const value = (record, key) => JSON.parse(record.getString(key))
  return { app, engine, add, draft, rule, snapshot, send, all, open, value }
}

test('normalizes rules, preserves CPU above 100 and validates numeric configuration', () => {
  const f = fixture()
  const rule = f.engine.normalizeRule(f.draft())
  assert.equal(rule.reminder_seconds, 900)
  assert.equal(rule.duration_seconds, 0)
  assert.equal(rule.severity, 'warning')
  assert.equal(f.engine.normalizeRule(f.draft({ condition: { metric: 'server.no_communication_seconds' } })).condition.value, 900)
  assert.throws(() => f.engine.normalizeRule(f.draft({ duration_seconds: '10' })))
  assert.throws(() => f.engine.normalizeRule(f.draft({ condition: { metric: 'container.cpu_percent', value: NaN } })))
  f.rule(); const raw = f.snapshot(start + 1000); raw.containers[0].cpu_percent = 250; f.send(raw)
  assert.equal(f.open().length, 1)
})

test('sustained evidence requires fresh positive observations and resets across gaps or null', () => {
  const f = fixture(); f.rule({ duration_seconds: 600 })
  f.send(f.snapshot(start + 1000)); f.send(f.snapshot(start + 301000))
  assert.equal(f.open().length, 0)
  f.send(f.snapshot(start + 601000)); assert.equal(f.open().length, 1)
  const g = fixture(); g.rule({ duration_seconds: 600 })
  g.send(g.snapshot(start + 1000)); g.send(g.snapshot(start + 602000))
  assert.equal(g.open().length, 0)
  const missing = g.snapshot(start + 902000); missing.containers[0].cpu_percent = null; g.send(missing)
  g.send(g.snapshot(start + 1202000)); assert.equal(g.open().length, 0)
  g.send(g.snapshot(start + 1502000)); g.send(g.snapshot(start + 1802000)); assert.equal(g.open().length, 1)
})

test('yesterday backlog, preactivation, unapplied, repeated and late samples cannot transition', () => {
  const f = fixture(); f.rule({ duration_seconds: 600 })
  f.send(f.snapshot(start - 86400000), start + 1000)
  f.send(f.snapshot(start), start + 1000)
  f.send(f.snapshot(start + 1000), start + 1000, { applied: false })
  assert.equal(f.all('alert_states').length, 0)
  f.send(f.snapshot(start + 1000)); f.send(f.snapshot(start + 1000), start + 601000)
  f.send(f.snapshot(start + 500)); assert.equal(f.open().length, 0)
  f.send(f.snapshot(start + 301000)); f.send(f.snapshot(start + 601000)); assert.equal(f.open().length, 1)
  const oldHealthy = f.snapshot(start + 500000); oldHealthy.containers[0].cpu_percent = 0; f.send(oldHealthy)
  assert.equal(f.open().length, 1)
})

test('future timestamps use receipt time and cannot accelerate minimum duration', () => {
  const f = fixture(); f.rule({ duration_seconds: 300 })
  f.send(f.snapshot(start + 301000), start + 1000)
  f.send(f.snapshot(start + 302000), start + 2000)
  assert.equal(f.open().length, 0)
  f.send(f.snapshot(start + 601000), start + 301000)
  assert.equal(f.open().length, 1)
})

test('event snapshots skip container numbers but retain fresh host and container-state evidence', () => {
  const f = fixture(); f.rule({ duration_seconds: 300 })
  f.rule({ name: 'Disk high', condition: { metric: 'host.disk_percent', operator: 'gt', value: 90 } }, 'disk')
  f.rule({ name: 'Stopped', condition: { metric: 'container.state', operator: 'eq', value: 'exited' } }, 'state')
  f.send(f.snapshot(start + 1000))
  const event = f.snapshot(start + 301000, { metrics_complete: false }); event.containers[0].cpu_percent = null; event.containers[0].state = 'exited'; f.send(event)
  assert.equal(f.open().length, 2)
  const state = f.all('alert_states').find(record => record.get('rule') === f.all('alert_rules')[0].id)
  assert.equal(f.value(state, 'data').last_usable, start + 1000)
  f.send(f.snapshot(start + 601000)); assert.equal(f.open().filter(record => record.get('title') === 'CPU high').length, 1)
})

test('event-only omitted host metric families skip without interrupting sustained evidence', () => {
  const families = [
    { metric: 'host.cpu_percent', host: { disks: [{ path: '/', total_bytes: 100, available_bytes: 5 }] } },
    { metric: 'host.memory_percent', host: { cpu_percent: 95, disks: [{ path: '/', total_bytes: 100, available_bytes: 5 }] } },
    { metric: 'host.disk_percent', host: { cpu_percent: 95 } }
  ]
  for (const family of families) {
    const f = fixture(); f.rule({ duration_seconds: 600, condition: { metric: family.metric, operator: 'gt', value: 90 } })
    f.send(f.snapshot(start + 1000))
    f.send(f.snapshot(start + 301000, { metrics_complete: false, host: family.host }))
    const data = f.value(f.all('alert_states')[0], 'data')
    assert.equal(data.last_usable, start + 1000, family.metric)
    assert.equal(data.pending_since, start + 1000, family.metric)
    assert.equal(f.open().length, 0, family.metric)
    f.send(f.snapshot(start + 601000))
    assert.equal(f.open().length, 1, family.metric)
  }
})

test('explicit null or invalid host families reset confirmation even in event-only samples', () => {
  const families = [
    { metric: 'host.cpu_percent', host: { cpu_percent: null } },
    { metric: 'host.cpu_percent', host: { cpu_percent: '95' } },
    { metric: 'host.memory_percent', host: { memory_total_bytes: null, memory_available_bytes: null } },
    { metric: 'host.memory_percent', host: { memory_total_bytes: 100 } },
    { metric: 'host.disk_percent', host: { disks: null } },
    { metric: 'host.disk_percent', host: { disks: [{ path: '/', total_bytes: 0, available_bytes: 0 }] } }
  ]
  for (const family of families) {
    const f = fixture(); f.rule({ duration_seconds: 600, condition: { metric: family.metric, operator: 'gt', value: 90 } })
    f.send(f.snapshot(start + 1000))
    f.send(f.snapshot(start + 301000, { metrics_complete: false, host: family.host }))
    assert.equal(f.value(f.all('alert_states')[0], 'data').pending_since, null, family.metric)
    f.send(f.snapshot(start + 601000))
    assert.equal(f.open().length, 0, family.metric)
  }
})

test('invalid denominators and absent affected disks cannot fabricate recovery', () => {
  const f = fixture(); f.rule({ condition: { metric: 'host.disk_percent', operator: 'gt', value: 90 } })
  f.send(f.snapshot(start + 1000)); assert.equal(f.open().length, 1)
  const absent = f.snapshot(start + 2000); absent.host.disks = [{ path: '/other', total_bytes: 100, available_bytes: 99 }]; f.send(absent)
  assert.equal(f.open().length, 1)
  const zero = f.snapshot(start + 3000); zero.host.disks[0].total_bytes = 0; f.send(zero)
  assert.equal(f.open().length, 1)
  const healthy = f.snapshot(start + 4000); healthy.host.disks[0].available_bytes = 50; f.send(healthy)
  assert.equal(f.open().length, 0)
  assert.equal(f.all('incidents')[0].get('resolution_reason'), 'recovered')
  const memory = fixture(); memory.rule({ condition: { metric: 'container.memory_percent', operator: 'gt', value: 90 } })
  const invalid = memory.snapshot(start + 1000); invalid.containers[0].memory_limit_bytes = 0; memory.send(invalid)
  assert.equal(memory.open().length, 0)
})

test('one disk incident contains all affected disks and missing evidence survives later positives', () => {
  const f = fixture(); f.rule({ condition: { metric: 'host.disk_percent', operator: 'gt', value: 90 } })
  const first = f.snapshot(start + 1000); first.host.disks.push({ path: '/data', total_bytes: 100, available_bytes: 1 }); f.send(first)
  assert.equal(f.open().length, 1); assert.equal(f.value(f.open()[0], 'evidence').affected_disks.length, 2)
  const next = f.snapshot(start + 2000); f.send(next)
  assert.equal(f.value(f.open()[0], 'evidence').affected_disks.length, 2)
  next.observed_at = new Date(start + 3000).toISOString(); next.host.disks[0].available_bytes = 50; f.send(next)
  assert.equal(f.open().length, 1)
})

test('manual close allows the next fresh positive occurrence using still-valid satisfied evidence', () => {
  const f = fixture(); f.rule({ duration_seconds: 300 })
  f.send(f.snapshot(start + 1000)); f.send(f.snapshot(start + 301000))
  const first = f.open()[0]; f.engine.resolve(f.app, first, 'manual', 'user', start + 302000)
  f.send(f.snapshot(start + 303000)); assert.equal(f.all('incidents').length, 2)
  assert.notEqual(f.open()[0].id, first.id)
  f.engine.resolve(f.app, f.open()[0], 'manual', 'user', start + 304000)
  const invalid = f.snapshot(start + 305000); invalid.containers[0].cpu_percent = null; f.send(invalid)
  f.send(f.snapshot(start + 306000)); assert.equal(f.open().length, 0)
})

test('claim concurrency, owner extension, expiry and recovery invalidate actionable notices', () => {
  const f = fixture(); f.rule(); f.send(f.snapshot(start + 1000))
  const incident = f.open()[0], until = new Date(start + 601000).toISOString()
  assert.equal(f.engine.validNotifications(f.app, 'org', '0', 100, start + 1000).items.length, 1)
  f.engine.claim(f.app, incident, 'alice', until, incident.get('version'), start + 2000)
  assert.equal(f.engine.validNotifications(f.app, 'org', '0', 100, start + 3000).items[0].kind, 'claimed')
  assert.throws(() => f.engine.claim(f.app, incident, 'bob', until, incident.get('version'), start + 3000), error => error.code === 409)
  assert.throws(() => f.engine.claim(f.app, incident, 'alice', until, 1, start + 3000), error => error.code === 409)
  f.engine.claim(f.app, incident, 'alice', new Date(start + 901000).toISOString(), incident.get('version'), start + 3000)
  assert.equal(f.engine.validNotifications(f.app, 'org', '0', 100, start + 4000).items[0].kind, 'claim_extended')
  f.engine.tick(f.app, start + 901000)
  assert.equal(f.engine.validNotifications(f.app, 'org', '0', 100, start + 901000).items.length, 1)
  f.engine.claim(f.app, incident, 'bob', new Date(start + 1201000).toISOString(), incident.get('version'), start + 902000)
  const healthy = f.snapshot(start + 903000); healthy.containers[0].cpu_percent = 1; f.send(healthy)
  assert.equal(f.open().length, 0)
  assert.equal(f.engine.validNotifications(f.app, 'org', '0', 100, start + 903000).items[0].kind, 'resolved')
  assert.ok(f.all('incident_events').some(record => record.get('kind') === 'claim_extended'))
  assert.ok(f.all('incident_events').some(record => record.get('kind') === 'claim_expired'))
})

test('restart ticks coalesce overdue reminders and feed reads never acknowledge or create', () => {
  const f = fixture(); f.rule(); f.send(f.snapshot(start + 1000))
  f.engine.tick(f.app, start + 86400000)
  const notices = f.all('incident_notifications'), count = notices.length
  assert.equal(notices.filter(record => record.get('valid')).length, 1)
  const feed = f.engine.validNotifications(f.app, 'org', '0', 100, start + 86400000)
  assert.equal(feed.items.length, 1)
  assert.equal(f.engine.validNotifications(f.app, 'org', feed.cursor, 100, start + 86400000).items.length, 0)
  assert.equal(f.engine.validNotifications(f.app, 'other-org', '0', 100, start + 86400000).items.length, 0)
  f.engine.validNotifications(f.app, 'org', '0', 100, start + 86400000)
  assert.equal(notices.length, count)
  assert.equal(Date.parse(f.open()[0].get('next_reminder_at')), start + 86400000 + 900000)
})

test('rule revisions close administratively, disable retains incidents and re-enable waits for evidence', () => {
  const f = fixture(); const rule = f.rule(); f.send(f.snapshot(start + 1000))
  const incident = f.open()[0]
  f.engine.saveRule(f.app, 'org', 'cpu', f.draft({ enabled: false }), 'user', start + 2000)
  assert.equal(f.open().length, 1)
  f.engine.tick(f.app, start + 1000000)
  assert.equal(f.engine.validNotifications(f.app, 'org', '0', 100, start + 1000000).items.length, 0)
  f.engine.saveRule(f.app, 'org', 'cpu', f.draft(), 'user', start + 1001000)
  f.engine.tick(f.app, start + 2000000)
  assert.equal(f.all('incident_notifications').filter(record => record.get('valid')).length, 0)
  f.send(f.snapshot(start + 2001000)); assert.equal(f.all('incident_notifications').filter(record => record.get('valid')).length, 1)
  f.engine.saveRule(f.app, 'org', 'cpu', f.draft({ duration_seconds: 300 }), 'user', start + 2002000)
  assert.equal(rule.get('revision'), 2)
  assert.equal(incident.get('resolution_reason'), 'rule_changed')
  f.send(f.snapshot(start + 2003000)); assert.equal(f.open().length, 0)
  f.send(f.snapshot(start + 2303000)); assert.equal(f.open().length, 1)
  f.engine.archiveRule(f.app, rule, 'user', start + 2304000)
  assert.equal(f.open().length, 0); assert.equal(f.all('incidents')[1].get('resolution_reason'), 'rule_archived')
})

test('PocketBase JSON key ordering does not manufacture rule revisions on disable or other edits', () => {
  const f = fixture(); const rule = f.rule(); f.send(f.snapshot(start + 1000)); const incident = f.open()[0]
  rule.set('condition', { value: 90, operator: 'gt', metric: 'container.cpu_percent' })
  f.engine.saveRule(f.app, 'org', 'cpu', f.draft({ enabled: false }), 'user', start + 2000)
  assert.equal(rule.get('revision'), 1)
  assert.equal(incident.get('status'), 'open')
  assert.equal(incident.get('next_reminder_at'), '')
  rule.set('condition', { operator: 'gt', metric: 'container.cpu_percent', value: 90 })
  f.engine.saveRule(f.app, 'org', 'cpu', f.draft({ enabled: false, name: 'Renamed', severity: 'critical' }), 'user', start + 3000)
  assert.equal(rule.get('revision'), 1)
  assert.equal(incident.get('status'), 'open')
  f.engine.saveRule(f.app, 'org', 'cpu', f.draft({ condition: { value: 95, operator: 'gt', metric: 'container.cpu_percent' } }), 'user', start + 4000)
  assert.equal(rule.get('revision'), 2)
  assert.equal(incident.get('resolution_reason'), 'rule_changed')
})

test('cadence changes preserve active claim deadlines and do not qualify as observations', () => {
  const f = fixture(); f.rule(); f.send(f.snapshot(start + 1000)); const incident = f.open()[0]
  const deadline = new Date(start + 9000000).toISOString()
  f.engine.claim(f.app, incident, 'user', deadline, incident.get('version'), start + 2000)
  f.engine.saveRule(f.app, 'org', 'cpu', f.draft({ reminder_seconds: 60, severity: 'critical' }), 'user', start + 3000)
  assert.equal(incident.get('claim_until'), deadline)
  assert.equal(incident.get('next_reminder_at'), deadline)
  assert.equal(f.all('incidents').length, 1)
})

test('workspace rules dynamically include inventory additions and isolate organizations', () => {
  const f = fixture(); f.rule()
  f.add('containers', 'container-two', { project: 'project', name: 'worker' })
  f.add('workspaces', 'foreign-workspace', { organization: 'foreign' })
  f.add('servers', 'foreign-server', { workspace: 'foreign-workspace', name: 'Foreign' })
  f.add('projects', 'foreign-project', { server: 'foreign-server' })
  f.add('containers', 'foreign-container', { project: 'foreign-project', name: 'foreign' })
  const raw = f.snapshot(start + 1000); raw.containers.push({ ...raw.containers[0], name: 'worker' })
  f.send(raw, start + 1000, { applied: true, containers: { web: 'container', worker: 'container-two' }, missing: [] })
  assert.equal(f.open().length, 2)
  assert.ok(f.open().every(record => record.get('organization') === 'org'))
  f.app.findRecordById('containers', 'container-two').set('project', 'foreign-project')
  f.engine.tick(f.app, start + 2000)
  assert.equal(f.open().length, 1)
})

test('missing container state requires a complete Docker inventory and explicit reconciliation mapping', () => {
  const f = fixture(); f.rule({ condition: { metric: 'container.state', operator: 'eq', value: 'missing' } })
  f.send(f.snapshot(start + 1000, { containers: [], docker_complete: false }), start + 1000, { applied: true, containers: {}, missing: ['container'] })
  assert.equal(f.open().length, 0)
  f.send(f.snapshot(start + 2000, { containers: [] }), start + 2000, { applied: true, containers: {}, missing: ['container'] })
  assert.equal(f.open().length, 1)
})

test('no-communication grace respects enrollment, ignores backlog and recovers on eligible contact', () => {
  const f = fixture(); f.rule({ condition: { metric: 'server.no_communication_seconds', operator: 'gte', value: 900 } })
  f.engine.tick(f.app, start + 899000); assert.equal(f.open().length, 0)
  f.engine.tick(f.app, start + 900000); assert.equal(f.open().length, 1)
  f.send(f.snapshot(start - 86400000), start + 901000); assert.equal(f.open().length, 1)
  f.send(f.snapshot(start + 902000)); assert.equal(f.open().length, 0)
  f.engine.tick(f.app, start + 1801000); assert.equal(f.open().length, 0)
  f.engine.tick(f.app, start + 1802000); assert.equal(f.open().length, 1)
  const g = fixture(); g.rule({ condition: { metric: 'server.no_communication_seconds', operator: 'gte', value: 900 } })
  g.app.findRecordById('server_agents', 'agent').set('created', new Date(start + 500000).toISOString())
  g.engine.tick(g.app, start + 1000000); assert.equal(g.open().length, 0)
  g.engine.tick(g.app, start + 1400000); assert.equal(g.open().length, 1)
})

test('delayed eligible communication cannot recover a shorter no-data threshold', () => {
  const f = fixture(); f.rule({ condition: { metric: 'server.no_communication_seconds', operator: 'gte', value: 60 } })
  f.engine.tick(f.app, start + 60000); const first = f.open()[0]
  f.send(f.snapshot(start + 1000), start + 120000)
  assert.equal(f.open()[0].id, first.id)
  f.send(f.snapshot(start + 121000)); assert.equal(f.open().length, 0)
})

test('source identities remain separate, preserve claims and never reopen terminal external IDs', () => {
  const f = fixture()
  const integration = f.add('alert_integrations', 'integration', { organization: 'org', kind: 'gcp', enabled: true, reminder_seconds: 900 })
  const other = f.add('alert_integrations', 'other', { organization: 'org', kind: 'generic', enabled: true, reminder_seconds: 900 })
  const event = { external_id: 'external', state: 'open', title: 'Source incident', evidence: { value: 1 } }
  const incident = f.engine.sourceEvent(f.app, integration, event, start)
  const initialAuditCount = f.all('incident_events').length
  f.engine.sourceEvent(f.app, integration, event, start + 500)
  assert.equal(f.all('incident_events').length, initialAuditCount)
  const deadline = new Date(start + 600000).toISOString()
  f.engine.claim(f.app, incident, 'alice', deadline, incident.get('version'), start + 1000)
  assert.equal(f.engine.sourceEvent(f.app, integration, event, start + 2000).id, incident.id)
  assert.equal(incident.get('claim_until'), deadline)
  f.engine.sourceEvent(f.app, other, event, start + 2000); assert.equal(f.open().length, 2)
  f.engine.resolve(f.app, incident, 'manual', 'user', start + 3000)
  f.engine.sourceEvent(f.app, integration, event, start + 4000)
  assert.equal(incident.get('status'), 'resolved')
  const closed = f.engine.sourceEvent(f.app, integration, { external_id: 'closed-first', state: 'closed' }, start + 5000)
  const notifications = f.all('incident_notifications').length
  f.engine.sourceEvent(f.app, integration, { external_id: 'closed-first', state: 'open' }, start + 6000)
  assert.equal(closed.get('status'), 'resolved'); assert.equal(f.all('incident_notifications').length, notifications)
})

test('source evidence equality ignores nested object ordering but preserves array ordering', () => {
  const f = fixture()
  const integration = f.add('alert_integrations', 'integration', { organization: 'org', kind: 'gcp', enabled: true, reminder_seconds: 900 })
  const event = { external_id: 'external', state: 'open', title: 'Source incident', evidence: { z: 1, nested: { z: 2, a: 3 }, values: [1, 2] } }
  const incident = f.engine.sourceEvent(f.app, integration, event, start)
  incident.set('evidence', { values: [1, 2], nested: { a: 3, z: 2 }, z: 1 })
  const initialAuditCount = f.all('incident_events').length
  f.engine.sourceEvent(f.app, integration, event, start + 1000)
  assert.equal(f.all('incident_events').length, initialAuditCount)
  f.engine.sourceEvent(f.app, integration, { ...event, evidence: { ...event.evidence, values: [2, 1] } }, start + 2000)
  assert.equal(f.all('incident_events').length, initialAuditCount + 1)
})

test('removal preserves immutable history and invalidates all pending notices', () => {
  const f = fixture(); const rule = f.rule(); const descendant = f.rule({ scope_type: 'container', scope_id: 'container' }, 'direct'); f.send(f.snapshot(start + 1000)); const incident = f.open()[0]
  f.engine.removeTarget(f.app, 'workspace', 'workspace', 'resource_transferred', 'admin', start + 2000)
  assert.equal(f.open().length, 0)
  assert.equal(incident.get('organization'), 'org')
  assert.equal(incident.get('resource_name'), 'web')
  assert.equal(incident.get('resolution_reason'), 'resource_transferred')
  assert.equal(rule.get('archived'), true)
  assert.equal(descendant.get('archived'), true)
  assert.equal(f.all('incident_notifications').filter(record => record.get('valid')).length, 0)
  assert.equal(f.all('incident_events').length, 4)
})

test('simulation uses raw latest telemetry, leaves storage unchanged and cannot prove duration', () => {
  const f = fixture(); const raw = f.snapshot(start + 1000, { metrics_complete: false })
  raw.containers[0].cpu_percent = null
  f.app.findRecordById('servers', 'server').set('telemetry', { observed_at: raw.observed_at })
  f.add('telemetry_samples', 'sample', { server: 'server', observed_at: raw.observed_at, payload: raw })
  const before = JSON.stringify(Object.fromEntries(['alert_rules', 'alert_states', 'incidents', 'incident_notifications'].map(table => [table, f.all(table)])))
  const preview = f.engine.simulate(f.app, 'org', f.draft({ duration_seconds: 300 }), start + 1000)
  assert.equal(preview.items[0].result, 'skipped')
  const disk = f.engine.simulate(f.app, 'org', f.draft({ condition: { metric: 'host.disk_percent', operator: 'gt', value: 90 } }), start + 1000)
  assert.equal(disk.items[0].result, 'true')
  assert.equal(JSON.stringify(Object.fromEntries(['alert_rules', 'alert_states', 'incidents', 'incident_notifications'].map(table => [table, f.all(table)]))), before)
})

test('manual resolution emits one closing event and never leaves reminders actionable',()=>{
 const f=fixture();f.rule();f.send(f.snapshot(start+1000));const incident=f.open()[0]
 f.engine.resolve(f.app,incident,'manual','alice',start+2000)
 const closing=f.engine.validNotifications(f.app,'org','0',100,start+3000).items
 assert.equal(closing.length,1);assert.equal(closing[0].kind,'resolved')
 const count=f.all('incident_notifications').length
 f.engine.resolve(f.app,incident,'manual','alice',start+4000);f.engine.tick(f.app,start+3600000)
 assert.equal(f.all('incident_notifications').length,count)
 assert.equal(incident.get('next_reminder_at'),'')
})
