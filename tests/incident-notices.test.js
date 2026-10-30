import test from 'node:test'
import assert from 'node:assert/strict'
import { createIncidentNoticeDisplay } from '../apps/web/src/incident-notices.ts'
import en from '../apps/web/src/locales/en/alerts.ts'
import pt from '../apps/web/src/locales/pt-BR/alerts.ts'
import uk from '../apps/web/src/locales/uk/alerts.ts'

const start = Date.parse('2026-10-30T12:00:00Z')
function fixture() {
  let clock = start
  const shown = []
  const display = createIncidentNoticeDisplay({
    now: () => clock,
    show: (notice, presentation, onDismiss) => {
      const row = { notice, presentation, dismissed: false, onDismiss }
      shown.push(row)
      return () => { row.dismissed = true }
    },
  })
  const notice = (kind, values = {}) => ({ incident_id: 'disk', title: 'Full disk', kind, occurred_at: '2026-10-30 12:00:01.000Z', ...values })
  return { display, shown, notice, setClock: value => { clock = value } }
}

test('workflow events have explicit captions and never fall through to reminders', () => {
  const f = fixture()
  for (const kind of ['opening', 'opened', 'reminder', 'resolved', 'claimed', 'claim_extended']) f.display.present(f.notice(kind))
  assert.deepEqual(f.shown.map(row => row.presentation.caption), [
    'incidents.newNotice', 'incidents.newNotice', 'incidents.reminderNotice',
    'incidents.resolvedNotice', 'incidents.claimedNotice', 'incidents.claimExtendedNotice',
  ])
  assert.equal(f.shown[3].presentation.icon, 'check_circle')
  assert.equal(f.shown[3].presentation.color, 'positive')
  for (const row of f.shown) for (const locale of [en, pt, uk]) assert.ok(locale[row.presentation.caption])
})

test('login and later history pages never replay old resolution or claim notifications', () => {
  const f = fixture()
  for (let index = 0; index < 130; index++) {
    for (const kind of ['resolved', 'claimed', 'claim_extended']) {
      f.display.present(f.notice(kind, { incident_id: 'history-' + index, occurred_at: '2026-10-29 12:00:00.000Z' }))
    }
  }
  assert.equal(f.shown.length, 0)
  f.display.present(f.notice('opening', { occurred_at: '2026-10-29 12:00:00.000Z' }))
  assert.equal(f.shown.length, 1)
  f.setClock(start + 2000); f.display.reset()
  f.display.present(f.notice('resolved'))
  assert.equal(f.shown.length, 1)
  assert.equal(f.shown[0].dismissed, true)
})

test('resolution replaces a visible reminder and its late dismissal cannot remove the replacement', () => {
  const f = fixture()
  f.display.present(f.notice('reminder'))
  f.display.present(f.notice('resolved'))
  assert.equal(f.shown[0].dismissed, true)
  assert.equal(f.shown[1].dismissed, false)
  f.shown[0].onDismiss()
  f.display.clear()
  assert.equal(f.shown[1].dismissed, true)
})

test('incidents with matching titles keep distinct notifications and later updates replace only their own', () => {
  const f = fixture()
  f.display.present(f.notice('reminder', { incident_id: 'disk-one' }))
  f.display.present(f.notice('reminder', { incident_id: 'disk-two' }))
  f.display.present(f.notice('claimed', { incident_id: 'disk-one' }))
  assert.deepEqual(f.shown.map(row => row.dismissed), [true, false, false])
  f.display.reset()
  assert.ok(f.shown.every(row => row.dismissed))
})

test('unknown event kinds are ignored and invalid workflow timestamps never appear as new events', () => {
  const f = fixture()
  for (const kind of ['changed', '', 'toString', '__proto__']) f.display.present(f.notice(kind))
  for (const occurred_at of ['', undefined, 'invalid']) f.display.present(f.notice('resolved', { occurred_at }))
  assert.equal(f.shown.length, 0)
  f.display.present(f.notice('resolved', { occurred_at: new Date(start).toISOString() }))
  assert.equal(f.shown.length, 1)
})

test('reconciliation dismisses an existing reminder even when the closing event predates this session', () => {
  const f = fixture()
  f.display.present(f.notice('reminder'))
  f.display.present(f.notice('resolved', { occurred_at: '2026-10-29 12:00:00.000Z' }))
  assert.equal(f.shown.length, 1)
  assert.equal(f.shown[0].dismissed, true)
})

test('startup batches show one summary and later events retain individual updates', () => {
 const f=fixture()
 f.display.presentBatch([f.notice('opening'),f.notice('reminder',{incident_id:'other'})],true,2,'Open incidents: 2')
 assert.equal(f.shown.length,1)
 assert.equal(f.shown[0].notice.kind,'summary')
 assert.equal(f.shown[0].notice.incident_id,'')
 f.display.presentBatch([f.notice('opening')],false,3,'')
 assert.equal(f.shown.length,2)
 f.display.reset()
 f.display.presentBatch([],true,0,'')
 assert.equal(f.shown.length,2)
})
