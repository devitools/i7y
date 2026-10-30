import {t} from './i18n'

export const requestLabels:Record<string,string>={authorize_connection:'Allow inventory queries',save_alert_rule:'Save alert rule',archive_alert_rule:'Archive alert rule',create_incident:'Create incident',claim_incident:'Claim incident',resolve_incident:'Resolve incident',submit_operation:'Run an operation'}
const stateLabels:Record<string,string>={approval_required:'Waiting for your approval',executing:'In progress',approved:'Approved',completed:'Completed',denied:'Declined',cancelled:'Cancelled',expired:'Expired',failed:'Failed',unknown:'Outcome unknown'}
export function requestTitle(request:any):string{return t(requestLabels[request.tool] || 'Review an action')}
export function requestState(state:string):string{return t(stateLabels[state] || 'Outcome unknown')}
export function clientName(client:any):string{return client?.title || client?.name || t('Local agent')}
export function backendName(value:string):string{try{return new URL(value).host}catch{return value || ''}}
export function approvalError(value:unknown):string {
  const message=String(value || '')
  if(/Cancelled|cancelled/i.test(message))return t('Authentication was cancelled. No access was granted.')
  if(/expired|changed|closed/i.test(message))return t('This request is no longer available. Ask the agent to try again.')
  if(/Unavailable|unavailable/i.test(message))return t('System authentication is unavailable. Access remains blocked.')
  return t('Unable to authorize this request. Access remains blocked.')
}
export function reviewParameters(request:any):Record<string,unknown>{
  const args={...(request.arguments || {})}
  delete args.client
  delete args.duration_seconds
  if(args.__reviewed_plan){args.plan=args.__reviewed_plan;delete args.__reviewed_plan}
  return args
}
export {pendingRequests,requestLink} from './mcp-requests'
