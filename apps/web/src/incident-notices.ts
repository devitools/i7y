export interface IncidentNotice {
  incident_id: string
  kind: string
  title: string
  occurred_at?: string
}

interface NoticePresentation {
  caption: string
  icon: string
  color?: string
}

const presentations: Record<string, NoticePresentation> = {
  summary: { caption: 'incidents.startupHelp', icon: 'notifications' },
  opening: { caption: 'incidents.newNotice', icon: 'notifications' },
  opened: { caption: 'incidents.newNotice', icon: 'notifications' },
  reminder: { caption: 'incidents.reminderNotice', icon: 'notifications' },
  resolved: { caption: 'incidents.resolvedNotice', icon: 'check_circle', color: 'positive' },
  claimed: { caption: 'incidents.claimedNotice', icon: 'person' },
  claim_extended: { caption: 'incidents.claimExtendedNotice', icon: 'schedule' },
}

export function createIncidentNoticeDisplay(options: {
  show: (notice: IncidentNotice, presentation: NoticePresentation, onDismiss: () => void) => () => void
  now?: () => number
}) {
  const now = options.now || Date.now
  const visible = new Map<string, { dismiss?: () => void }>()
  let startedAt = now()

  function clear() {
    for (const entry of visible.values()) entry.dismiss?.()
    visible.clear()
  }

  function reset() {
    clear()
    startedAt = now()
  }

  function present(notice: IncidentNotice) {
    if (!Object.hasOwn(presentations, notice.kind)) return
    const presentation = presentations[notice.kind]
    visible.get(notice.incident_id)?.dismiss?.()
    visible.delete(notice.incident_id)
    if (['resolved', 'claimed', 'claim_extended'].includes(notice.kind)) {
      const occurredAt = Date.parse((notice.occurred_at || '').replace(' ', 'T'))
      if (!Number.isFinite(occurredAt) || occurredAt < startedAt) return
    }
    const entry: { dismiss?: () => void } = {}
    visible.set(notice.incident_id, entry)
    entry.dismiss = options.show(notice, presentation, () => {
      if (visible.get(notice.incident_id) === entry) visible.delete(notice.incident_id)
    })
  }

  function presentBatch(items: IncidentNotice[], initial: boolean, openCount: number, title: string) {
    if (initial) {
      if (openCount > 0) present({incident_id:'',kind:'summary',title})
      return
    }
    for (const notice of items) present(notice)
  }

  return { present, presentBatch, reset, clear }
}
