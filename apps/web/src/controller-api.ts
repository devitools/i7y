import {invoke} from '@tauri-apps/api/core'
import {desktopRuntime} from './desktop-backend'
export interface ControllerAction {id:string;title:string;target:string;permission:string;enabled:boolean;status:string}
export interface ControllerCapabilities {version:1;principal:string;backend:string;organization:string;catalog:{version:1;actions:ControllerAction[]}}
export type OperationKind='server_inspect'|'server_disk'|'container_list'|'project_copy'|'container_start'|'container_stop'|'container_restart'
export interface ControllerOperation {action:OperationKind;target:string;destination_domain?:string|null}
export type ControllerRequest={command:'capabilities'}|{command:'ping';target:string}|{command:'plan';operation_id:string;operation:ControllerOperation}|{command:'status';operation_id:string}|{command:'submit';operation_id:string;approval:string}
export interface ControllerPing {version:1;backend:string;organization:string;target:string;reachable:boolean;checked_at:number}
export async function controllerRequest<T>(organization:string,request:ControllerRequest):Promise<T>{
  if(!desktopRuntime)throw {kind:'execution_disabled'}
  return invoke<T>('controller_request',{organization,request})
}
export function controllerError(cause:unknown):string|null{
  if(!cause || typeof cause!=='object' || !('kind' in cause))return null
  const error=cause as {kind:string;detail?:string}
  if(error.kind==='transport')return error.detail || 'connection_failed'
  return ({invalid_request:'Review the selected action and target.',invalid_response:'The automation host returned an unsupported executor response.',scope_mismatch:'The automation host belongs to a different backend or organization.',denied:'The automation host denied this request. Check the operator permissions.',execution_disabled:'Remote changes are not enabled in this desktop build.'})[error.kind] || null
}
