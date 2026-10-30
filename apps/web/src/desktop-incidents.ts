import { isTauri } from '@tauri-apps/api/core'

interface NativeIncidentWindow {
  setBadgeCount(count?: number): Promise<void>
  isFocused(): Promise<boolean>
  requestAttention(): Promise<void>
}
interface IncidentNotice {
  sequence: number | string
  incident_id: string
  kind: string
  severity?: string
  occurred_at?: string
}
interface IncidentFeed {
  open_count: number
  cursor: string | number
  items?: IncidentNotice[]
}
interface DesktopIncidentOptions {
  nativeWindow?: () => Promise<NativeIncidentWindow | null>
  now?: () => number
}

async function nativeWindow(): Promise<NativeIncidentWindow | null> {
  if (!isTauri()) return null
  const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window')
  const current = getCurrentWindow()
  return {
    setBadgeCount: count => current.setBadgeCount(count),
    isFocused: () => current.isFocused(),
    requestAttention: () => current.requestUserAttention(UserAttentionType.Informational),
  }
}

function position(value: unknown): bigint {
  const text = String(value ?? '')
  return /^\d+$/.test(text) ? BigInt(text) : 0n
}

export function createDesktopIncidentSync(options: DesktopIncidentOptions = {}) {
  const load = options.nativeWindow || nativeWindow, now = options.now || Date.now
  let windowPromise: Promise<NativeIncidentWindow | null> | undefined
  let pending: Promise<void> = Promise.resolve()
  let context: string | null = null, generation = 0, revision = 0, disposed = false
  let startedAt = now(), bootstrapping = true, cursor = 0n
  const seen = new Set<string>()

  function window() {
    if (!windowPromise) windowPromise = Promise.resolve().then(load).catch(error => { windowPromise = undefined; throw error })
    return windowPromise
  }
  function enqueue(action: () => Promise<void>) {
    pending = pending.then(action).catch(() => {})
  }
  function clear() {
    const version = generation
    enqueue(async () => {
      const current = await window()
      if (version === generation) await current?.setBadgeCount(undefined)
    })
  }
  function setContext(key: string) {
    if (disposed || key === context) return
    context = key; generation++; revision++; startedAt = now(); bootstrapping = true; cursor = 0n; seen.clear()
    clear()
  }
  function update(key: string, feed: IncidentFeed) {
    if (disposed || !key || key !== context) return
    const version = generation, request = ++revision, notices = feed.items || []
    let attention = false, next = cursor
    for (const notice of notices) {
      const sequence = position(notice.sequence)
      if (sequence > next) next = sequence
      if (sequence <= cursor || !['opening', 'opened'].includes(notice.kind)) continue
      const known = seen.has(notice.incident_id)
      seen.add(notice.incident_id)
      const occurred = typeof notice.occurred_at === 'string' ? Date.parse(notice.occurred_at.replace(' ', 'T')) : NaN
      if (!bootstrapping && !known && notice.severity === 'critical' && Number.isFinite(occurred) && occurred >= startedAt) attention = true
    }
    cursor = position(feed.cursor) > next ? position(feed.cursor) : next
    if (notices.length < 100) bootstrapping = false
    const count = Number.isSafeInteger(feed.open_count) && feed.open_count > 0 ? feed.open_count : undefined
    enqueue(async () => {
      const current = await window()
      if (!current || version !== generation || request !== revision || disposed) return
      await current.setBadgeCount(count)
      if (!attention || !count || version !== generation || request !== revision || disposed) return
      const focused = await current.isFocused()
      if (!focused && version === generation && request === revision && !disposed) await current.requestAttention()
    })
  }
  function dispose() {
    if (disposed) return
    disposed = true; context = ''; generation++; revision++; seen.clear(); cursor = 0n
    clear()
  }
  return { setContext, update, dispose, idle: () => pending }
}
