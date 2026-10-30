import { pb } from './api'

const base = '/api/i7y/alerts/v1'
function unavailable() {return Object.assign(new Error('Alerts API is unavailable on the selected backend'),{code:'alerts_api_unavailable'})}
const send = async (path: string, method = 'GET', body?: unknown, query?: Record<string, unknown>) => {
  let result
  try {result=await pb.send(base + path, { method, body, query, requestKey: null })}
  catch (error:any) {
    if(method==='GET' && error.status===404 && ['/metrics','/rules','/incidents','/integrations','/notification-events'].includes(path))throw unavailable()
    throw error
  }
  if(method!=='DELETE' && (!result || typeof result!=='object' || (!Array.isArray(result.items) && typeof result.id!=='string')))throw unavailable()
  return result
}
export function alertLoadError(error:any, fallback:string) {return error?.code==='alerts_api_unavailable'?'alerts.backendUnavailable':fallback}
const segment = (value: string) => encodeURIComponent(value)
async function allPages(path: string) {
  const first = await send(path, 'GET', undefined, {page: 1, perPage: 100})
  const items = [...first.items]
  for (let page = 2; page <= first.totalPages; page++) items.push(...(await send(path, 'GET', undefined, {page, perPage: 100})).items)
  return {...first, items}
}
export const alertsApi = {
  metrics: () => send('/metrics'),
  rules: () => allPages('/rules'),
  rule: (key: string) => send('/rules/' + segment(key)),
  saveRule: (key: string, body: unknown) => send('/rules/' + segment(key), 'PUT', body),
  archiveRule: (key: string) => send('/rules/' + segment(key), 'DELETE'),
  simulate: (body: unknown) => send('/rules/simulate', 'POST', body),
  integrations: () => allPages('/integrations'),
  createIntegration: (body: unknown) => send('/integrations', 'POST', body),
  updateIntegration: (id: string, body: unknown) => send('/integrations/' + segment(id), 'PATCH', body),
  revokeIntegration: (id: string) => send('/integrations/' + segment(id), 'DELETE'),
  rotateIntegration: (id: string) => send('/integrations/' + segment(id) + '/rotate', 'POST'),
  incidents: (query: Record<string, unknown> = {}) => send('/incidents', 'GET', undefined, query),
  incident: (id: string) => send('/incidents/' + segment(id)),
  claim: (id: string, claim_until: string, version: number) => send('/incidents/' + segment(id) + '/claim', 'POST', {claim_until, version}),
  resolve: (id: string, version: number) => send('/incidents/' + segment(id) + '/resolve', 'POST', {version}),
  notifications: (cursor = '0') => send('/notification-events', 'GET', undefined, {cursor, limit: 100}),
}
export function alertTimestamp(value: string) {
  return Date.parse((value || '').replace(' ', 'T'))
}
export function incidentPhase(incident: any, now = Date.now()) {
  if (incident.status === 'resolved') return 'resolved'
  if (!incident.assignee) return 'open'
  return alertTimestamp(incident.claim_until) > now ? 'inProgress' : 'overdue'
}
export function severityColor(severity: string) {
  return severity === 'critical' ? 'negative' : severity === 'warning' ? 'warning' : 'info'
}
export function inventoryLabel(record: any) {
  return record.name || record.login || record.hostname || record.id
}
export function integrationEndpoint(integration: any) {
  return new URL(base + '/integrations/' + segment(integration.id) + (integration.kind === 'gcp' ? '/gcp' : '/events'), new URL(pb.baseURL, window.location.origin)).href
}
