import { invoke } from '@tauri-apps/api/core'
import { desktopAuthApi } from './api'
import { waitForDesktopAuthorization } from './desktop-login-flow'

export { desktopRuntime } from './desktop-backend'
export function randomDesktopSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), value=>value.toString(16).padStart(2,'0')).join('')
}
export async function desktopChallenge(verifier: string): Promise<string> {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))
  return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('')
}
export async function browserSignIn(signal: AbortSignal, onRequest: (code: string)=>void): Promise<void> {
  await desktopAuthApi.available()
  const request=randomDesktopSecret(),verifier=randomDesktopSecret()
  onRequest(request.slice(0,8).toUpperCase())
  await invoke('open_browser_login',{request,challenge:await desktopChallenge(verifier)})
  await waitForDesktopAuthorization({signal,exchange:()=>desktopAuthApi.exchange(request,verifier,signal)})
}
