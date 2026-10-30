export async function waitForDesktopAuthorization({exchange,signal,timeout=300000,interval=2000,now=Date.now,pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))}:{exchange:()=>Promise<boolean>;signal:AbortSignal;timeout?:number;interval?:number;now?:()=>number;pause?:(ms:number)=>Promise<void>}):Promise<void> {
  const deadline=now()+timeout
  while(!signal.aborted && now()<deadline) {
    try {if(await exchange()){if(signal.aborted)break;return}}
    catch(error) {
      if(signal.aborted)break
      const status=Number(error?.status || 0)
      if(status>0 && status!==408 && status!==429 && status<500)throw error
    }
    await pause(interval)
  }
  if(signal.aborted)throw new DOMException('Aborted','AbortError')
  throw Object.assign(new Error('Desktop authorization timed out'),{code:'desktop_authorization_timeout'})
}
