import PocketBase, { BaseAuthStore } from 'pocketbase'
import { invoke } from '@tauri-apps/api/core'
import { ref, shallowReactive } from 'vue'
import { desktopFetchFor, desktopConnections, type DesktopConnection } from './desktop-backend'
import { createOrganizationTransport } from './organization-context'
export interface ConnectedSource {id:string;name:string;url:string;client:PocketBase;organizations:any[];globalAdmin:boolean;generation:number;error:string;unavailable:boolean}
export const connectionRevision=ref(0)
const sources=new Map<string,ConnectedSource>()
let changed:(source:ConnectedSource)=>void=()=>{}
export function onConnectionAuthChange(callback:(source:ConnectedSource)=>void) {changed=callback}
export function connectionClient(id:string):ConnectedSource {
  const source=sources.get(id)
  if(!source)throw new Error('Connection unavailable')
  return source
}
export function connectionClients() {connectionRevision.value;return [...sources.values()]}
export function setupConnection(connection:DesktopConnection) {
  if(sources.has(connection.id)) {const source=sources.get(connection.id)!;source.name=connection.name;return source}
  const client=new PocketBase(connection.url,new BaseAuthStore())
  const source=shallowReactive<ConnectedSource>({...connection,client,organizations:[],globalAdmin:false,generation:0,error:'',unavailable:false})
  const transport=createOrganizationTransport(()=>null,desktopFetchFor(connection.id),()=>client.authStore.token)
  client.beforeSend=transport.beforeSend
  client.afterSend=(response,data)=>{transport.afterSend(response,data);if(response.status===401 && client.authStore.token)client.authStore.clear();return data}
  client.authStore.onChange(()=>{
    source.generation++;source.unavailable=false
    transport.invalidate()
    if(!client.authStore.isValid){source.organizations=[];source.globalAdmin=false}
    connectionRevision.value++
    changed(source)
  })
  sources.set(connection.id,source)
  connectionRevision.value++
  return source
}
export async function loadConnectionOrganizations(id:string) {
  const source=connectionClient(id),generation=source.generation
  const result=await source.client.send('/api/i7y/organizations',{method:'GET',requestKey:null})
  if(generation!==source.generation || sources.get(id)!==source)throw new Error('Connection session changed')
  source.organizations=result.items;source.globalAdmin=result.global_admin;source.error=''
  connectionRevision.value++
  return result
}
export async function restoreConnection(id:string,legacyToken?:string|null) {
  const source=connectionClient(id),generation=source.generation
  try {
    const session=await invoke<{token:string;record:any}|null>('desktop_session_restore',{connectionId:id,legacyToken:legacyToken || null})
    if(generation!==source.generation || sources.get(id)!==source)return
    source.error='';source.unavailable=false
    if(session) {source.client.authStore.save(session.token,session.record);await loadConnectionOrganizations(id)}
  } catch {if(generation===source.generation){source.error='connections.unavailable';source.unavailable=true;connectionRevision.value++}}
}
export function forgetConnection(id:string) {const source=sources.get(id);if(source){source.generation++;source.client.cancelAllRequests();sources.delete(id);connectionRevision.value++}}
export function updateConnectionNames() {for(const item of desktopConnections.value){const source=sources.get(item.id);if(source)source.name=item.name}connectionRevision.value++}
