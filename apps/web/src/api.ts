import type { RouteState } from './types'
import PocketBase, { BaseAuthStore } from 'pocketbase'
import { invoke } from '@tauri-apps/api/core'
import { desktopRuntime, desktopFetchFor, desktopBackend, desktopConnections, activeConnectionId, readDesktopConnections, syncDesktopContext } from './desktop-backend'
import { ref } from 'vue'
import { createOrganizationTransport } from './organization-context.ts'
import { connectionClient, connectionClients, setupConnection, restoreConnection, onConnectionAuthChange, loadConnectionOrganizations, forgetConnection, updateConnectionNames, connectionRevision } from './connection-clients'
export { connectionRevision } from './connection-clients'
export { activeConnectionId, desktopConnections } from './desktop-backend'
import { telemetrySince, serverStats } from './telemetry-summary.ts'
import { createQueryCache } from './query-cache.ts'
import { inventoryQuery } from './inventory-query.ts'
import { createManagementApi } from './management.ts'
export const pb = new PocketBase(desktopRuntime?'https://backend.invalid/':import.meta.env.VITE_POCKETBASE_URL || '/', desktopRuntime ? new BaseAuthStore() : undefined)
export const authStore = pb.authStore
let browserSessionGeneration=0
const browserInboxClient=desktopRuntime?null:new PocketBase(pb.baseURL,authStore)
if(browserInboxClient){
  const transport=createOrganizationTransport(()=>null,undefined,()=>authStore.token)
  browserInboxClient.beforeSend=transport.beforeSend
  browserInboxClient.afterSend=(response,data)=>{transport.afterSend(response,data);if(response.status===401 && authStore.token)authStore.clear();return data}
}
export const activeOrganization = ref<string|null>(null)
export const organizationChoices = ref([])
export const globalAdmin = ref(false)
const organizationTransport=createOrganizationTransport(()=>activeOrganization.value,undefined,()=>authStore.token,desktopRuntime?()=>desktopFetchFor(activeConnectionId.value):undefined)
pb.beforeSend=organizationTransport.beforeSend
export function setOrganization(id) {
  if(id===activeOrganization.value){if(desktopRuntime)syncDesktopContext(id);return}
  organizationTransport.invalidate()
  pb.cancelAllRequests()
  cache.clear()
  activeOrganization.value=id
  if(desktopRuntime)syncDesktopContext(id)
  if(id)localStorage.setItem(organizationStorageKey(),id)
}
function organizationStorageKey() {return 'i7y.organization.'+(desktopRuntime?activeConnectionId.value+'.':'')+authStore.record?.id}
export async function loadOrganizations() {
  const result=await pb.send('/api/i7y/organizations',{method:'GET',requestKey:null})
  organizationChoices.value=result.items
  globalAdmin.value=result.global_admin
  if(desktopRuntime && activeConnectionId.value){const source=connectionClient(activeConnectionId.value);source.organizations=result.items;source.globalAdmin=result.global_admin;connectionRevision.value++}
  const saved=localStorage.getItem(organizationStorageKey())
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
let selectingConnection=false
let syncingConnection=false
const pendingLogouts=new Map<string,Promise<unknown>>()
authStore.onChange(() => {
  cache.clear();browserSessionGeneration++;connectionRevision.value++
  if(desktopRuntime && activeConnectionId.value && !selectingConnection && !syncingConnection) {
    const id=activeConnectionId.value,source=connectionClient(id)
    syncingConnection=true
    try {source.client.authStore.save(authStore.token,authStore.record)} finally {syncingConnection=false}
    if(!authStore.token) {
      const pending=invoke('desktop_connection_logout',{connectionId:id}).finally(()=>{if(pendingLogouts.get(id)===pending)pendingLogouts.delete(id)})
      pendingLogouts.set(id,pending);void pending.catch(()=>{})
    }
  }
  if(!authStore.isValid){organizationTransport.invalidate();activeOrganization.value=null;organizationChoices.value=[];globalAdmin.value=false}
})
onConnectionAuthChange(source=>{
  if(source.id!==activeConnectionId.value || selectingConnection || syncingConnection)return
  syncingConnection=true
  try {authStore.save(source.client.authStore.token,source.client.authStore.record)} finally {syncingConnection=false}
})

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

function desktopLoginApi(client:PocketBase) {
  return {
    available:async()=>{
      const result=await client.send('/api/i7y/desktop',{method:'GET',requestKey:null})
      if(result?.browser_login!==true)throw Object.assign(new Error('Browser sign-in unavailable'),{status:404})
      return result
    },
    exchange:async(request:string,verifier:string,signal?:AbortSignal)=>{
      const result=await client.send('/api/i7y/desktop/exchange',{method:'POST',body:{request,verifier},requestKey:null,signal})
      if(!signal?.aborted && result.token && result.record)client.authStore.save(result.token,result.record)
      return !!result.token
    },
  }
}
export const desktopAuthApi={
  ...desktopLoginApi(pb),
  authorize:(request:string,challenge:string)=>pb.send('/api/i7y/desktop/authorize',{method:'POST',body:{request,challenge}}),
  forConnection:(id:string)=>desktopLoginApi(connectionClient(id).client),
}

export function connectedSources() {
  if(desktopRuntime)return connectionClients().filter(source=>source.client.authStore.isValid)
  connectionRevision.value
  return authStore.isValid?[{id:'browser',name:new URL(pb.baseURL,window.location.origin).host,url:pb.baseURL,client:browserInboxClient!,organizations:organizationChoices.value,globalAdmin:globalAdmin.value,generation:browserSessionGeneration,error:'',unavailable:false}]:[]
}
export function incidentSourceClient(connectionId:string,organization:string) {
  const source=desktopRuntime?connectionClient(connectionId):connectedSources().find(source=>source.id===connectionId)
  if(!source || !source.client.authStore.isValid || !source.organizations.some(item=>item.id===organization))throw new Error('Incident source unavailable')
  const generation=source.generation,token=source.client.authStore.token
  const current=()=>desktopRuntime?source.generation===generation && connectionClients().includes(source):browserSessionGeneration===generation
  return {source,send:async(path:string,options:any={})=>{
    if(!current() || source.client.authStore.token!==token)throw new Error('Connection session changed')
    const result=await source.client.send(path,{...options,headers:{...options.headers,'X-I7y-Organization':organization},requestKey:null})
    if(!current() || source.client.authStore.token!==token)throw new Error('Connection session changed')
    return result
  }}
}
function applySelectedConnection(id:string) {
  const source=id?connectionClient(id):null
  selectingConnection=true
  try {
    organizationTransport.invalidate();pb.cancelAllRequests();cache.clear()
    pb.baseURL=source?.url || 'https://backend.invalid/'
    activeOrganization.value=null;organizationChoices.value=[];globalAdmin.value=false
    authStore.save(source?.client.authStore.token || '',source?.client.authStore.record || null)
    if(source?.client.authStore.isValid){organizationChoices.value=source.organizations;globalAdmin.value=source.globalAdmin}
  } finally {selectingConnection=false}
}
export async function initializeDesktopBackend(): Promise<void> {
  if(!desktopRuntime)return
  const registry=await readDesktopConnections()
  for(const item of registry.items)setupConnection(item)
  const legacyRaw=localStorage.getItem('pocketbase_auth')
  let legacyToken:string|null=null
  try {if(desktopBackend.value && localStorage.getItem('i7y.desktop.authBackend')===desktopBackend.value)legacyToken=JSON.parse(legacyRaw || '{}').token || null}catch {}
  await Promise.allSettled(registry.items.map(item=>restoreConnection(item.id,item.id===registry.selected?legacyToken:null)))
  applySelectedConnection(registry.selected || '')
  localStorage.removeItem('pocketbase_auth');localStorage.removeItem('i7y.desktop.authBackend')
}
let connectionSelectionGeneration=0
export async function selectConnection(id:string):Promise<void> {
  if(id===activeConnectionId.value)return
  const generation=++connectionSelectionGeneration
  organizationTransport.invalidate();pb.cancelAllRequests()
  await invoke('select_connection',{connectionId:id})
  await readDesktopConnections()
  if(generation!==connectionSelectionGeneration)return
  applySelectedConnection(activeConnectionId.value)
  if(authStore.isValid)await loadOrganizations()
}
export async function addConnection(url:string,name='') {
  const connection=await invoke<any>('add_connection',{backendUrl:url,name})
  setupConnection(connection)
  await readDesktopConnections()
  return connection
}
export async function renameConnection(id:string,name:string) {
  await invoke('rename_connection',{connectionId:id,name})
  await readDesktopConnections();updateConnectionNames()
}
export async function logoutConnection(id:string) {
  await invoke('desktop_connection_logout',{connectionId:id})
  const source=connectionClient(id)
  source.client.authStore.clear()
}
export async function removeConnection(id:string) {
  const wasSelected=id===activeConnectionId.value
  await invoke('remove_connection',{connectionId:id})
  forgetConnection(id);await readDesktopConnections()
  if(wasSelected)applySelectedConnection(activeConnectionId.value)
}
export async function selectDesktopBackend(url: string): Promise<void> {
  const connection=await addConnection(url)
  await selectConnection(connection.id)
}
export async function prepareConnectionLogin(id:string) {await pendingLogouts.get(id);return connectionClient(id)}
export async function retryConnection(id:string) {await restoreConnection(id);if(id===activeConnectionId.value && authStore.isValid)await loadOrganizations()}
export async function refreshConnectedOrganizations() {
  if(!desktopRuntime) {
    if(!authStore.isValid)return
    const generation=browserSessionGeneration
    const result=await browserInboxClient!.send('/api/i7y/organizations',{method:'GET',requestKey:null})
    if(generation!==browserSessionGeneration)return
    organizationChoices.value=result.items;globalAdmin.value=result.global_admin;connectionRevision.value++
    if(activeOrganization.value && !result.items.some(item=>item.id===activeOrganization.value))setOrganization(result.items[0]?.id || null)
    return
  }
  await Promise.allSettled(connectionClients().map(source=>source.client.authStore.isValid?loadConnectionOrganizations(source.id):source.unavailable?restoreConnection(source.id):Promise.resolve()))
  const source=connectionClients().find(source=>source.id===activeConnectionId.value)
  if(source?.client.authStore.isValid){organizationChoices.value=source.organizations;globalAdmin.value=source.globalAdmin;if(activeOrganization.value && !source.organizations.some(item=>item.id===activeOrganization.value))setOrganization(source.organizations[0]?.id || null)}
}
