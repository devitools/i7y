import { pb, incidentSourceClient } from './api'

const base = '/api/i7y/alerts/v1'
function unavailable() {return Object.assign(new Error('Alerts API is unavailable on the selected backend'),{code:'alerts_api_unavailable'})}
const send = async (path: string, method = 'GET', body?: unknown, query?: Record<string, unknown>, headers?: Record<string,string>, rulesV2 = false) => {
  let result
  try {result=await pb.send((rulesV2 ? '/api/i7y/alerts/v2' : base) + path, { method, body, query, headers, requestKey: null })}
  catch (error:any) {
    if(method==='GET' && error.status===404 && ['/metrics','/rules','/incidents','/integrations','/notification-events'].includes(path))throw unavailable()
    throw error
  }
  if(method!=='DELETE' && (!result || typeof result!=='object' || (!Array.isArray(result.items) && typeof result.id!=='string')))throw unavailable()
  return result
}
export function alertLoadError(error:any, fallback:string) {return error?.code==='alerts_api_unavailable'?'alerts.backendUnavailable':fallback}
const segment = (value: string) => encodeURIComponent(value)
async function allPages(path: string, rulesV2 = false) {
  const first = await send(path, 'GET', undefined, {page: 1, perPage: 100}, undefined, rulesV2)
  const items = [...first.items]
  for (let page = 2; page <= first.totalPages; page++) items.push(...(await send(path, 'GET', undefined, {page, perPage: 100}, undefined, rulesV2)).items)
  return {...first, items}
}
export function incidentAlertsApi(connectionId:string,organization:string) {
  const client=incidentSourceClient(connectionId,organization)
  const scoped=(path:string,method='GET',body?:unknown,headers?:Record<string,string>,v2=false)=>client.send((v2?'/api/i7y/alerts/v2':base)+path,{method,body,headers})
  return {
    incident:(id:string)=>scoped('/incidents/'+segment(id)),
    claim:(id:string,claim_until:string,version:number)=>scoped('/incidents/'+segment(id)+'/claim','POST',{claim_until,version}),
    resolve:(id:string,version:number)=>scoped('/incidents/'+segment(id)+'/resolve','POST',{version}),
    rules:async()=>{
      const first=await scoped('/rules?page=1&perPage=100','GET',undefined,undefined,true),items=[...first.items]
      for(let page=2;page<=first.totalPages;page++)items.push(...(await scoped('/rules?page='+page+'&perPage=100','GET',undefined,undefined,true)).items)
      return {...first,items}
    },
    rule:(key:string)=>scoped('/rules/'+segment(key),'GET',undefined,undefined,true),
    saveRule:(key:string,body:unknown,version:number)=>scoped('/rules/'+segment(key),'PUT',body,{'X-I7y-Expected-Revision':String(version)},true),
  }
}
export const alertsApi = {
  metrics: () => send('/metrics', 'GET', undefined, undefined, undefined, true),
  rules: () => allPages('/rules', true),
  rule: (key: string) => send('/rules/' + segment(key), 'GET', undefined, undefined, undefined, true),
  saveRule: (key: string, body: unknown, version = 0) => send('/rules/' + segment(key), 'PUT', body, undefined, {'X-I7y-Expected-Revision':String(version)}, true),
  archiveRule: (key: string, version: number) => send('/rules/' + segment(key), 'DELETE', undefined, undefined, {'X-I7y-Expected-Revision':String(version)}, true),
  simulate: (body: unknown, page = 1) => send('/rules/simulate', 'POST', body, {page,perPage:100}, undefined, true),
  previewMigration: (options: unknown = {}) => send('/migration/preview', 'POST', {options}, undefined, undefined, true),
  applyMigration: (plan_hash: string, options: unknown) => send('/migration/apply', 'POST', {plan_hash,options}, undefined, undefined, true),
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
