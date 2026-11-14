import {activeConnectionId,activeOrganization,authStore,connectedSources,incidentSourceClient,pb} from './api'
import {desktopRuntime} from './desktop-backend'
export interface PowerNativeContext {
  connectionId:string
  connectionGeneration:number
  lockEpoch:number
  context:{backend:string;user:string;organization:string;generation:number}
}
export function samePowerContext(a:PowerNativeContext|undefined,b:PowerNativeContext|undefined) {
  return !!a&&!!b&&a.connectionId===b.connectionId&&a.connectionGeneration===b.connectionGeneration&&a.lockEpoch===b.lockEpoch&&a.context.backend===b.context.backend&&a.context.user===b.context.user&&a.context.organization===b.context.organization&&a.context.generation===b.context.generation
}
export function powerProgressMatches(expected:PowerNativeContext|undefined,server:string,request:string,event:{server_id:string;request_id:string;context:PowerNativeContext}) {
  return event.server_id===server&&event.request_id===request&&samePowerContext(expected,event.context)
}
export interface PowerSourceIdentity {connectionId:string;backend:string;user:string;organization:string;session:string;generation:number}
export function captureServerPowerSource() {
  const connectionId=desktopRuntime?activeConnectionId.value:'browser',organization=activeOrganization.value
  const source=connectedSources().find(item=>item.id===connectionId)
  if(!organization || !source || !authStore.isValid)throw new Error('context_changed')
  const identity:PowerSourceIdentity={connectionId,organization,backend:new URL(source.url,window.location.origin).href,user:source.client.authStore.record?.id || '',session:source.client.authStore.token,generation:source.generation}
  const client=incidentSourceClient(connectionId,organization)
  const current=()=>{
    const selected=connectedSources().find(item=>item.id===identity.connectionId)
    return !!selected && (desktopRuntime?activeConnectionId.value:'browser')===identity.connectionId && activeOrganization.value===identity.organization && selected.generation===identity.generation && selected.client.authStore.token===identity.session && selected.client.authStore.record?.id===identity.user && authStore.token===identity.session && authStore.record?.id===identity.user && new URL(pb.baseURL,window.location.origin).href===identity.backend
  }
  if(!current())throw new Error('context_changed')
  return {identity,current,nativeSource:{connectionId,organization,backend:identity.backend,user:identity.user,session:identity.session},send:async(path:string,options:any)=>{
    if(!current())throw new Error('context_changed')
    const result=await client.send(path,options)
    if(!current())throw new Error('context_changed')
    return result
  }}
}
export type ServerPowerSource=ReturnType<typeof captureServerPowerSource>
const path=(server:string)=>'/api/i7y/server-power/v1/servers/'+encodeURIComponent(server)
export function createServerPowerApi(source:ServerPowerSource) {
  return {
    get:(server:string)=>source.send(path(server),{method:'GET'}),
    save:(server:string,body:unknown)=>source.send(path(server),{method:'PUT',body}),
    reconcile:(server:string,job:string)=>source.send(path(server)+'/jobs/'+encodeURIComponent(job)+'/reconcile',{method:'POST',body:{inspected_console:true}}),
  }
}
