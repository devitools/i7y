export function pendingRequests(requests:any[]=[],at=Date.now()/1000):any[]{return requests.filter(p=>p.state==='approval_required'&&p.expires_at>at).sort((a,b)=>a.expires_at-b.expires_at || a.id.localeCompare(b.id))}
export function requestLink(request?:string):string{return '#/desktop/mcp?tab=requests'+(request?'&request='+encodeURIComponent(request):'')}
export function requestTab(hash:string):string{const value=new URLSearchParams(hash.split('?')[1] || '').get('tab');return ['requests','connections','operations','history'].includes(value || '')?value!:'requests'}
