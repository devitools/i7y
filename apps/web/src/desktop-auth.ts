import { invoke } from '@tauri-apps/api/core'
import { desktopAuthApi, prepareConnectionLogin } from './api'
import { activeConnectionId } from './desktop-backend'
import { waitForDesktopAuthorization } from './desktop-login-flow'

export { desktopRuntime } from './desktop-backend'
export function randomDesktopSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), value=>value.toString(16).padStart(2,'0')).join('')
}
export async function desktopChallenge(verifier: string): Promise<string> {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))
  return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('')
}
export async function browserSignIn(signal: AbortSignal, onRequest: (code: string)=>void, connectionId=activeConnectionId.value): Promise<void> {
  const assertActive=()=>{if(signal.aborted)throw new DOMException('Aborted','AbortError')}
  assertActive()
  await prepareConnectionLogin(connectionId)
  assertActive()
  const api=desktopAuthApi.forConnection(connectionId)
  await api.available()
  assertActive()
  const request=randomDesktopSecret(),verifier=randomDesktopSecret()
  const challenge=await desktopChallenge(verifier)
  assertActive()
  onRequest(request.slice(0,8).toUpperCase())
  assertActive()
  await invoke('open_browser_login',{connectionId,request,challenge})
  assertActive()
  await waitForDesktopAuthorization({signal,exchange:()=>api.exchange(request,verifier,signal)})
}
