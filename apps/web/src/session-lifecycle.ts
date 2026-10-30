interface SessionStore {
  isValid: boolean
  token: string
  record: {collectionName?:string} | null
}
interface SessionApi {
  refreshSession: () => Promise<unknown>
  signOut: () => void
}
export async function restoreSession(api: SessionApi, store: SessionStore): Promise<boolean> {
  const valid=()=>store.isValid && store.record?.collectionName==='users'
  if(!valid()){api.signOut();return false}
  const token=store.token
  try {await api.refreshSession()}
  catch(error) {if([400,401,403].includes(error?.status) && store.token===token)api.signOut()}
  return valid()
}
export function createSessionCompletion(complete:()=>Promise<void>,identity:()=>string=()=>'session'): ()=>Promise<void> {
  let pending: {key:string;promise:Promise<void>} | null=null
  return ()=>{
    const key=identity()
    if(pending?.key===key)return pending.promise
    const promise=Promise.resolve().then(complete).finally(()=>{if(pending?.promise===promise)pending=null})
    pending={key,promise}
    return promise
  }
}
