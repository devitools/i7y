import type { RouteState } from './types'
import PocketBase, { BaseAuthStore } from 'pocketbase'
import { invoke } from '@tauri-apps/api/core'
import { desktopRuntime, desktopFetch, desktopBackend, readDesktopBackend, persistDesktopBackend, syncDesktopContext } from './desktop-backend'
import { ref } from 'vue'
import { createOrganizationTransport } from './organization-context.ts'
import { telemetrySince, serverStats } from './telemetry-summary.ts'
import { createQueryCache } from './query-cache.ts'
import { inventoryQuery } from './inventory-query.ts'
import { createManagementApi } from './management.ts'
export const pb = new PocketBase(desktopRuntime?'https://backend.invalid/':import.meta.env.VITE_POCKETBASE_URL || '/', desktopRuntime ? new BaseAuthStore() : undefined)
export const authStore = pb.authStore
export const activeOrganization = ref(null)
export const organizationChoices = ref([])
export const globalAdmin = ref(false)
const organizationTransport=createOrganizationTransport(()=>activeOrganization.value,desktopRuntime?desktopFetch:undefined,()=>authStore.token)
pb.beforeSend=organizationTransport.beforeSend
export function setOrganization(id) {
  if(id===activeOrganization.value){if(desktopRuntime)syncDesktopContext(id);return}
  organizationTransport.invalidate()
  pb.cancelAllRequests()
  cache.clear()
  activeOrganization.value=id
  if(desktopRuntime)syncDesktopContext(id)
  if(id)localStorage.setItem('i7y.organization.'+authStore.record?.id,id)
}
export async function loadOrganizations() {
  const result=await pb.send('/api/i7y/organizations',{method:'GET',requestKey:null})
  organizationChoices.value=result.items
  globalAdmin.value=result.global_admin
  const saved=localStorage.getItem('i7y.organization.'+authStore.record?.id)
  setOrganization(result.items.find(r=>r.id===(activeOrganization.value || saved))?.id || result.items[0]?.id || null)
  return result
}
export const organizationApi={
  create:name=>pb.send('/api/i7y/organizations',{method:'POST',body:{name}}),
  rename:(id,name)=>pb.send('/api/i7y/organizations/'+id,{method:'PATCH',body:{name}}),
  remove:id=>pb.send('/api/i7y/organizations/'+id,{method:'DELETE'}),
  members:org=>pb.send('/api/i7y/organizations/'+org+'/members',{method:'GET',requestKey:null}),
  updateMember:(org,id,role)=>pb.send('/api/i7y/organizations/'+org+'/members/'+id,{method:'PATCH',body:{role}}),
  removeMember:(org,id)=>pb.send('/api/i7y/organizations/'+org+'/members/'+id,{method:'DELETE'}),
  invitations:org=>pb.send('/api/i7y/organizations/'+org+'/invitations',{method:'GET',requestKey:null}),
  invite:(org,values)=>pb.send('/api/i7y/organizations/'+org+'/invitations',{method:'POST',body:values}),
  revoke:(org,id)=>pb.send('/api/i7y/organizations/'+org+'/invitations/'+id,{method:'DELETE'}),
  inspect:token=>pb.send('/api/i7y/invitations/inspect',{method:'POST',body:{token}}),
  accept:values=>pb.send('/api/i7y/invitations/accept',{method:'POST',body:values}),
  transfer:(id,organization)=>pb.send('/api/i7y/workspaces/'+id+'/transfer',{method:'POST',body:{organization}}),
}
pb.afterSend = (response, data) => {
  organizationTransport.afterSend(response,data)
  if (response.status === 401 && pb.authStore.token) pb.authStore.clear()
  return data
}
export const tokenApi = {
  list: () => pb.send('/api/i7y/tokens', {method:'GET',requestKey:null}),
  create: values => pb.send('/api/i7y/tokens', {method:'POST',body:values}),
  revoke: id => pb.send(`/api/i7y/tokens/${encodeURIComponent(id)}`, {method:'DELETE'}),
}
const cache = createQueryCache()
export const invalidateInventory = () => cache.clear()
authStore.onChange(() => {if(desktopRuntime && !authStore.token)void invoke('desktop_session_clear');if(desktopRuntime){if(authStore.isValid)localStorage.setItem('i7y.desktop.authBackend',desktopBackend.value);else localStorage.removeItem('i7y.desktop.authBackend')}cache.clear();if(!authStore.isValid){organizationTransport.invalidate();activeOrganization.value=null;organizationChoices.value=[];globalAdmin.value=false}})
const rawManagement = createManagementApi(pb)
export const management = {...rawManagement}
for (const method of ['create','update','remove']) management[method]=async(...args)=>{
  if(method==='create' && args[0]==='workspaces')args[1]={...args[1],organization:activeOrganization.value}
  const result=await rawManagement[method](...args)
  cache.clear()
  return result
}
export async function inventoryPage(resource, values: RouteState={}, {force=false}={}) {
  const query=inventoryQuery(pb,resource,values)
  const key=JSON.stringify([authStore.record?.id,activeOrganization.value,resource,query])
  return cache.get(key,async()=>{
    const result=await pb.collection('i7y_'+resource).getList(query.page,query.perPage,query.options)
    return {...result,items:result.items.map(row=>typeof row.payload==='string'?JSON.parse(row.payload):row.payload)}
  },{force})
}
export async function inventoryProjectOptions(values: RouteState={}) {
  const {search='',matchingSearch='',page=1,...scope}=values
  const query=inventoryQuery(pb,'containers',{...scope,search:matchingSearch,perPage:100})
  const key=JSON.stringify([authStore.record?.id,activeOrganization.value,'matching-projects',query.options])
  const ids=await cache.get(key,async()=>{
    const ids=new Set<string>()
    for(let page=1;;page++) {
      const result=await pb.collection('i7y_containers').getList(page,100,{...query.options,fields:'project_id',skipTotal:true})
      for(const row of result.items) if(row.project_id)ids.add(row.project_id)
      if(result.items.length<100)break
    }
    return [...ids]
  })
  return inventoryPage('projects',{workspace:scope.workspace,server:scope.server,ids,search,page,perPage:50,sortBy:'name'})
}
export async function inventoryServerStats(ids,{force=false}={}) {
  if(!ids.length)return {}
  const key=JSON.stringify([authStore.record?.id,activeOrganization.value,'server-stats',ids])
  return cache.get(key,async()=>{
    const filter=ids.map(id=>pb.filter('id = {:id}',{id})).join(' || ')
    const records=await pb.collection('servers').getList(1,100,{filter,fields:'id,telemetry',requestKey:null})
    const containers={}
    const scope=ids.map(id=>pb.filter('project.server = {:id}',{id})).join(' || ')
    for(let page=1;;page++) {
      const result=await pb.collection('containers').getList(page,100,{filter:scope,expand:'project',fields:'telemetry.state,telemetry.health,expand.project.server',skipTotal:true,requestKey:null})
      for(const row of result.items) {
        const server=row.expand?.project?.server
        if(server)(containers[server] ||= []).push(row)
      }
      if(result.items.length<100)break
    }
    return Object.fromEntries(records.items.map(row=>[row.id,serverStats(row.telemetry,containers[row.id] || [])]))
  },{force})
}
export async function inventoryScope(resource,key,workspace=null,server=null) {
  if (!key) return null
  const direct=/^[a-z0-9]{15}$/.test(key)
  const values=direct ? {id:key} : {legacyOrder:Number(key.split(':').at(-1)),workspace,server}
  return (await inventoryPage(resource,{...values,perPage:1})).items[0] || null
}

export const telemetryApi = {
  containers: server => pb.collection('containers').getFullList({filter:pb.filter('project.server = {:server}',{server}),fields:'id,name,project,telemetry',requestKey:null}),
  trends: (server,days) => pb.collection('telemetry_samples').getFullList({filter:pb.filter('server = {:server} && observed_at >= {:since}',{server,since:telemetrySince(days)}),sort:'observed_at',fields:'id,observed_at,payload.host',requestKey:null}),
  current: server => Promise.all(['projects','containers'].map(name=>pb.collection(name).getFullList({filter:pb.filter(name==='projects'?'server = {:server}':'project.server = {:server}',{server}),requestKey:null}))),
  agents: () => pb.send('/api/i7y/agents', {method:'GET',requestKey:null}),
  provision: server => pb.send('/api/i7y/agents', {method:'POST',body:{server}}),
  revoke: id => pb.send(`/api/i7y/agents/${encodeURIComponent(id)}`, {method:'DELETE'}),
  history: (server,days) => pb.collection('telemetry_samples').getFullList({filter:pb.filter('server = {:server} && observed_at >= {:since}', {server,since:telemetrySince(days)}),sort:'observed_at',requestKey:null}),
}

export async function inventoryOperatingSystems(workspace=null) {
 const key=JSON.stringify([authStore.record?.id,activeOrganization.value,'operating-systems',workspace])
 return cache.get(key,async()=>{
  const rows=await pb.collection('i7y_servers').getFullList({fields:'id,os_name',filter:workspace?pb.filter('workspace_login = {:workspace}',{workspace}):'',requestKey:null})
  return [...new Set(rows.map(row=>row.os_name).filter(Boolean))].sort((a,b)=>a.localeCompare(b))
 })
}

export const desktopAuthApi = {
  available: async () => {
    const result=await pb.send('/api/i7y/desktop', {method:'GET',requestKey:null})
    if(result?.browser_login!==true)throw Object.assign(new Error('Browser sign-in unavailable'),{status:404})
    return result
  },
  authorize: (request: string, challenge: string) => pb.send('/api/i7y/desktop/authorize', {method:'POST',body:{request,challenge}}),
  exchange: async (request: string, verifier: string, signal?: AbortSignal) => {
    const result = await pb.send('/api/i7y/desktop/exchange', {method:'POST',body:{request,verifier},requestKey:null,signal})
    if (!signal?.aborted && result.token && result.record) pb.authStore.save(result.token,result.record)
    return !!result.token
  },
}

export async function initializeDesktopBackend(): Promise<void> {
  if(!desktopRuntime)return
  const backend=await readDesktopBackend()
  if(backend)pb.baseURL=backend
  const legacyRaw=localStorage.getItem('pocketbase_auth')
  let legacyToken:string|null=null
  try {if(backend && localStorage.getItem('i7y.desktop.authBackend')===backend)legacyToken=JSON.parse(legacyRaw || '{}').token || null}catch {}
  if(backend){
    const restored=await invoke<{token:string;record:any}|null>('desktop_session_restore',{legacyToken})
    if(restored)pb.authStore.save(restored.token,restored.record)
  }
  localStorage.removeItem('pocketbase_auth')
}
export async function selectDesktopBackend(url: string): Promise<void> {
  if(url===desktopBackend.value)return
  const backend=await persistDesktopBackend(url)
  organizationTransport.invalidate()
  pb.cancelAllRequests()
  pb.authStore.clear()
  cache.clear()
  pb.baseURL=backend
}
