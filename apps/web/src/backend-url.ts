export function normalizeBackendUrl(value: string): string {
  const url=new URL(value.trim())
  if(url.username || url.password || url.search || url.hash)throw new Error('Invalid backend URL')
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Remote backends must use HTTPS')
  if(!url.pathname.endsWith('/'))url.pathname+='/'
  return url.href
}
