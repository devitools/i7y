import { invoke, isTauri } from '@tauri-apps/api/core'
import { ref } from 'vue'
export const desktopBackend=ref('')
export const desktopBackendError=ref(false)
export const desktopRuntime=isTauri()
export const activeConnectionId=ref('')
export interface DesktopConnection {id:string;name:string;url:string;instance_id?:string}
export const desktopConnections=ref<DesktopConnection[]>([])

export async function readDesktopConnections() {
  const result=await invoke<{items:DesktopConnection[];selected:string|null}>('get_connections')
  desktopConnections.value=result.items
  activeConnectionId.value=result.selected || ''
  desktopBackend.value=result.items.find(item=>item.id===result.selected)?.url || ''
  return result
}
export async function readDesktopBackend(): Promise<string> {
  await readDesktopConnections()
  return desktopBackend.value
}
export async function persistDesktopBackend(backendUrl: string): Promise<string> {
  const connection=await invoke<DesktopConnection>('add_connection',{backendUrl,name:''})
  await invoke('select_connection',{connectionId:connection.id})
  await readDesktopConnections()
  return connection.url
}
export function desktopFetchFor(connectionId:string):typeof fetch {
  return async(input,options: RequestInit={})=>{
    if(options.signal?.aborted)throw new DOMException('Aborted','AbortError')
    if(options.body!=null && typeof options.body!=='string')throw new Error('Unsupported desktop request body')
    const url=input instanceof Request?input.url:String(input)
    const headers=Object.fromEntries(new Headers(options.headers).entries())
    const result=await invoke<{status:number;body:string;content_type:string}>('backend_request',{connectionId,url,method:options.method || 'GET',headers,body:options.body ?? null})
    if(options.signal?.aborted)throw new DOMException('Aborted','AbortError')
    return new Response([204,205,304].includes(result.status)?null:result.body,{status:result.status,headers:{'Content-Type':result.content_type}})
  }
}
export const desktopFetch:typeof fetch=(input,options)=>desktopFetchFor(activeConnectionId.value)(input,options)
let desktopContext:Promise<unknown>=Promise.resolve()
export function syncDesktopContext(organization:string|null):void {
  const connectionId=activeConnectionId.value
  if(!connectionId)return
  desktopContext=desktopContext.catch(()=>{}).then(()=>invoke('desktop_session_context',{connectionId,organization}))
  void desktopContext.catch(()=>{})
}
