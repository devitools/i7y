import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDesktopIncidentSync } from '../apps/web/src/desktop-incidents.ts'

const start = Date.parse('2026-10-29T12:00:00Z')
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(overrides = {}) {
  const badges = [], attentions = [], focused = { value: false }
  const window = {
    setBadgeCount: async count => { badges.push(count) },
    isFocused: async () => focused.value,
    requestAttention: async () => { attentions.push('brief') },
    ...overrides,
  }
  const sync = createDesktopIncidentSync({ nativeWindow: async () => window, now: () => start })
  const notice = (sequence, values = {}) => ({ sequence, incident_id: 'incident-' + sequence, kind: 'opening', severity: 'critical', occurred_at: new Date(start + 1000).toISOString(), ...values })
  const feed = (count, items = [], cursor = items.at(-1)?.sequence || '0') => ({ open_count: count, items, cursor })
  return { sync, badges, attentions, focused, notice, feed }
}

test('native badge mirrors selected organization open count and zero removes the badge', async () => {
  const f = fixture(); f.sync.setContext('alice:org-a'); await f.sync.idle()
  assert.deepEqual(f.badges, [undefined])
  f.sync.update('alice:org-a', f.feed(7)); await f.sync.idle()
  f.sync.update('alice:org-a', f.feed(0)); await f.sync.idle()
  assert.deepEqual(f.badges, [undefined, 7, undefined])
  assert.equal(f.attentions.length, 0)
})

test('initial load, relogin and multiple pages of history never request attention', async () => {
  const f = fixture(); f.sync.setContext('alice:org-a')
  const history = Array.from({ length: 100 }, (_, index) => f.notice(index + 1))
  f.sync.update('alice:org-a', f.feed(150, history)); await f.sync.idle()
  f.sync.update('alice:org-a', f.feed(150, [f.notice(101)])); await f.sync.idle()
  assert.equal(f.attentions.length, 0)
  f.sync.setContext(''); f.sync.setContext('alice:org-a')
  f.sync.update('alice:org-a', f.feed(150, [f.notice(101)])); await f.sync.idle()
  assert.equal(f.attentions.length, 0)
  f.sync.update('alice:org-a', f.feed(151, [f.notice(102, { occurred_at: '2026-10-28 12:00:00.000Z' })])); await f.sync.idle()
  assert.equal(f.attentions.length, 0)
})

test('only a new critical opening while unfocused requests one brief attention per batch', async () => {
  const f = fixture(); f.sync.setContext('alice:org-a'); f.sync.update('alice:org-a', f.feed(0)); await f.sync.idle()
  f.sync.update('alice:org-a', f.feed(2, [f.notice(1), f.notice(2)])); await f.sync.idle()
  assert.deepEqual(f.attentions, ['brief'])
  f.sync.update('alice:org-a', f.feed(2, [f.notice(1), f.notice(2)])); await f.sync.idle()
  f.sync.update('alice:org-a', f.feed(2, [f.notice(3, { kind: 'reminder' }), f.notice(4, { severity: 'warning' })])); await f.sync.idle()
  f.sync.update('alice:org-a', f.feed(2, [f.notice(5, { incident_id: 'incident-1' })])); await f.sync.idle()
  assert.equal(f.attentions.length, 1)
  f.focused.value = true
  f.sync.update('alice:org-a', f.feed(3, [f.notice(6)])); await f.sync.idle()
  assert.equal(f.attentions.length, 1)
})

test('a late native badge write cannot outlive an organization reset or disposal', async () => {
  const old = deferred(), started = deferred(), applied = []
  const f = fixture({ setBadgeCount: async count => {
    if (count === 9) { started.resolve(); await old.promise }
    applied.push(count)
  } })
  f.sync.setContext('alice:org-a'); await f.sync.idle()
  f.sync.update('alice:org-a', f.feed(9)); await started.promise
  f.sync.setContext('alice:org-b')
  f.sync.update('alice:org-a', f.feed(99))
  old.resolve(); await f.sync.idle()
  assert.deepEqual(applied, [undefined, 9, undefined])
  f.sync.update('alice:org-b', f.feed(2)); await f.sync.idle()
  f.sync.dispose(); await f.sync.idle()
  f.sync.update('alice:org-b', f.feed(10)); await f.sync.idle()
  assert.deepEqual(applied.slice(-2), [2, undefined])
})

test('stale focus completions cannot bounce after logout or newer incident state', async () => {
  for (const reset of [true, false]) {
    const focus = deferred(), checking = deferred()
    const f = fixture({ isFocused: () => { checking.resolve(); return focus.promise } })
    f.sync.setContext('alice:org-a'); f.sync.update('alice:org-a', f.feed(0)); await f.sync.idle()
    f.sync.update('alice:org-a', f.feed(1, [f.notice(1)])); await checking.promise
    if (reset) f.sync.setContext('')
    else f.sync.update('alice:org-a', f.feed(0, [], '1'))
    focus.resolve(false); await f.sync.idle()
    assert.equal(f.attentions.length, 0)
    assert.equal(f.badges.at(-1), undefined)
  }
})

test('native errors are contained and later badge updates still run', async () => {
  let failures = 0
  const f = fixture({ setBadgeCount: async count => { if (count === 1) { failures++; throw Error('native unavailable') } f.badges.push(count) } })
  f.sync.setContext('alice:org-a'); await f.sync.idle()
  f.sync.update('alice:org-a', f.feed(1)); await f.sync.idle()
  f.sync.update('alice:org-a', f.feed(2)); await f.sync.idle()
  assert.equal(failures, 1)
  assert.equal(f.badges.at(-1), 2)
  f.sync.dispose(); await f.sync.idle()
  assert.equal(f.badges.at(-1), undefined)
})

test('ordinary browsers are no-ops and native capability grants match the used commands', async () => {
  const sync = createDesktopIncidentSync()
  sync.setContext('alice:org-a'); sync.update('alice:org-a', { open_count: 4, items: [], cursor: '0' }); await sync.idle()
  sync.dispose(); await sync.idle()
  const capability = JSON.parse(readFileSync(new URL('../apps/desktop/src-tauri/capabilities/main.json', import.meta.url), 'utf8'))
  assert.ok(capability.permissions.includes('core:window:allow-set-badge-count'))
  assert.ok(capability.permissions.includes('core:window:allow-request-user-attention'))
  const helper = readFileSync(new URL('../apps/web/src/desktop-incidents.ts', import.meta.url), 'utf8')
  assert.ok(helper.includes('UserAttentionType.Informational'))
  assert.equal(helper.includes('UserAttentionType.Critical'), false)
  const component = readFileSync(new URL('../apps/web/src/components/IncidentNotifications.vue', import.meta.url), 'utf8')
  assert.ok(component.includes('desktopIncidents.setContext(context())'))
  assert.ok(component.includes('desktopIncidents.update(key,result)'))
  assert.ok(component.includes('desktopIncidents.dispose()'))
})
