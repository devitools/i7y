import { invoke, isTauri } from '@tauri-apps/api/core'
import { ref } from 'vue'
export const desktopBackend=ref('')
export const desktopBackendError=ref(false)
export const desktopRuntime=isTauri()

export async function readDesktopBackend(): Promise<string> {
  desktopBackend.value=await invoke<string | null>('get_backend') || ''
  return desktopBackend.value
}
export async function persistDesktopBackend(backendUrl: string): Promise<string> {
  const result=await invoke<string>('set_backend',{backendUrl})
  desktopBackend.value=result
  return result
}
export const desktopFetch: typeof fetch=async(input,options: RequestInit={})=>{
  await desktopContext.catch(()=>{})
  if(options.signal?.aborted)throw new DOMException('Aborted','AbortError')
  if(options.body!=null && typeof options.body!=='string')throw new Error('Unsupported desktop request body')
  const url=input instanceof Request?input.url:String(input)
  const headers=Object.fromEntries(new Headers(options.headers).entries())
  const result=await invoke<{status:number;body:string;content_type:string}>('backend_request',{url,method:options.method || 'GET',headers,body:options.body ?? null})
  await desktopContext.catch(()=>{})
  if(options.signal?.aborted)throw new DOMException('Aborted','AbortError')
  return new Response([204,205,304].includes(result.status)?null:result.body,{status:result.status,headers:{'Content-Type':result.content_type}})
}

let desktopContext:Promise<unknown>=Promise.resolve()
export function syncDesktopContext(organization:string|null):void {
  desktopContext=desktopContext.catch(()=>{}).then(()=>invoke('desktop_session_context',{organization}))
  void desktopContext.catch(()=>{})
}
