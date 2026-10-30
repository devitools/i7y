import { routeHash } from './routes'
import { containerStateText } from './telemetry-summary'

export function incidentTargetHref(row: any) {
  const valid = (id: unknown) => typeof id === 'string' && /^[a-z0-9]{15}$/.test(id)
  if (row.resource_type === 'server' && valid(row.server_id || row.resource_id)) return routeHash({view:'telemetry',server:row.server_id || row.resource_id})
  if (row.resource_type === 'container' && valid(row.server_id) && row.resource_name) return routeHash({view:'containers',server:row.server_id,search:row.resource_name,statuses:[]})
  return null
}

export function incidentMetric(row: any, translate: (key: string) => string, language: string) {
  const evidence = row.evidence || {}, value = evidence.value ?? evidence.observed_value
  const metric = typeof evidence.metric === 'string' ? evidence.metric : ''
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—'
    const formatted = new Intl.NumberFormat(language,{maximumFractionDigits:1}).format(value)
    return formatted + (metric.endsWith('_percent') ? '%' : metric === 'server.no_communication_seconds' ? ' s' : '')
  }
  if (metric === 'container.state') return translate(containerStateText({state:value}))
  return typeof value === 'string' || typeof value === 'boolean' ? String(value) : '—'
}
