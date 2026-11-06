export const COPY_RETRY_DELAY_MS=30_000

export function retryableCopyTransport(reason:unknown):boolean {
  return reason==='connection_failed' || reason==='timed_out'
}

export async function retryCopy<T extends {error?:string;retryable?:boolean}>(run:()=>Promise<T>,wait:()=>Promise<boolean>,active:()=>boolean):Promise<T> {
  for(let attempt=0;;attempt++){
    const value=await run()
    if(!value.error || !value.retryable || attempt>=3 || !active())return value
    if(!await wait() || !active())return value
  }
}
