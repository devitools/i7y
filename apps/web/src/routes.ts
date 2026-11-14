import type { ListState, RouteState } from './types'
import { normalizeStatuses } from './container-status.ts'
const views = { telemetry: 'telemetry', workspaces: 'accounts', servers: 'servers', projects: 'projects', containers: 'containers', images: 'images' }
export function readRoute(hash: string): RouteState {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?')
  const params = new URLSearchParams(query)
  const parts = path.split('/')
  if(parts[0]==='projects' && parts.length===4 && parts[2]==='actions' && parts[3]==='copy'){
    try{return {view:'projectCopy',id:decodeURIComponent(parts[1]),returnTo:inventoryReturn(params.get('returnTo'))}}
    catch{return {view:'accounts'}}
  }
  if(parts[0]==='servers' && parts.length===4 && parts[2]==='actions' && parts[3]==='ping')return {view:'serverPing',server:decodeURIComponent(parts[1]),returnTo:inventoryReturn(params.get('returnTo'))}
  if(path==='desktop/mcp')return {view:'desktopMcp'}
  if(path==='desktop/controller')return {view:'controllerSettings'}
  if(path==='desktop/connections')return {view:'connections',action:'list',returnTo:connectionsReturn(params.get('returnTo'))}
  if(path==='desktop/connections/new')return {view:'connections',action:'new',returnTo:connectionsReturn(params.get('returnTo'))}
  if(parts[0]==='desktop' && parts[1]==='connections' && parts.length===4 && ['edit','remove'].includes(parts[3])){
    try{return {view:'connections',action:parts[3],id:decodeURIComponent(parts[2]),returnTo:connectionsReturn(params.get('returnTo'))}}
    catch{return {view:'connections',action:'list',returnTo:null}}
  }
  if(path==='alerts')return {view:'alerts',action:'list',section:'rules'}
  if(path==='alerts/new')return {view:'alerts',action:'new',section:'rules'}
  if(path==='alerts/integrations')return {view:'alerts',action:'list',section:'integrations'}
  if(parts[0]==='alerts' && parts.length===3 && parts[2]==='edit')return {view:'alerts',action:'edit',section:'rules',key:decodeURIComponent(parts[1])}
  if(path==='incidents')return {view:'incidents',action:'list'}
  if(parts[0]==='incidents' && parts.length===2){try{return {view:'incidents',action:'detail',id:decodeURIComponent(parts[1]),...(params.get('connection')?{connection:params.get('connection')}:{}),...(params.get('organization')?{organization:params.get('organization')}:{})}}catch{return {view:'incidents',action:'list'}}}
  if (parts[0] === 'servers' && parts.length === 3 && parts[2] === 'agent-installation') return {view:'agentInstall',server:decodeURIComponent(parts[1])}
  if (path === 'tokens') return {view:'tokens',action:'list'}
  if (path === 'tokens/new') return {view:'tokens',action:'new'}
  if (parts[0] === 'tokens' && parts.length === 3 && parts[2] === 'revoke') return {view:'tokens',action:'revoke',id:parts[1]}
  if (parts[0] === 'invite' && parts.length===2) return {view:'invite',token:parts[1]}
  if(parts[0]==='organizations' && /^[a-z0-9]{15}$/.test(parts[1] || ''))return {...readRoute('#/organizations/'+parts.slice(2).join('/')+(query?'?'+query:'')),organization:parts[1]}
  if (parts[0]==='organizations') {
    if(parts.length===1)return {view:'organizations',section:'organizations',action:'list'}
    if(['new','edit','delete','transfer'].includes(parts[1]) && parts.length===2)return {view:'organizations',section:'organizations',action:parts[1]}
    if(['members','invitations'].includes(parts[1]) && (parts.length===2 || (parts.length===3 && parts[1]==='invitations' && parts[2]==='new') || (parts.length===4 && (parts[1]==='members'?['edit','delete']:['revoke']).includes(parts[3]))))return {view:'organizations',section:parts[1],action:parts.length===2?'list':parts.length===3?'new':parts[3],id:parts.length===4?parts[2]:null}
  }
  if (path === 'desktop-authorize') return {view:'desktopAuthorize'}
  if (path === 'mobile-authorize') return {view:'mobileAuthorize'}
  if (path === 'login') return {view:'login'}
  if(path==='manage/containers/bulk-delete') return {view:'bulkDelete',resource:'containers',ids:[...new Set(params.getAll('id').filter(id=>/^[a-z0-9]{15}$/.test(id)))].slice(0,100),returnTo:inventoryReturn(params.get('returnTo'))}
  if (parts[0] === 'manage' && ['workspaces','servers','projects','containers'].includes(parts[1]) && ((parts[2] === 'new' && parts.length === 3) || (parts[2] && ['edit','delete'].includes(parts[3]) && parts.length === 4))) {
    return {view:'manage', resource:parts[1], action:parts[2] === 'new' ? 'new' : parts[3], id:parts[2] === 'new' ? null : parts[2], parent:params.get('parent'), ...(managementReturn(params.get('returnTo')) ? {returnTo:managementReturn(params.get('returnTo'))} : {})}
  }
  const state=readListState(params)
  if(params.has('status')) {
    const statuses=normalizeStatuses(params.getAll('status'))
    state.statuses=params.getAll('status').includes('all')?[]:statuses.length?statuses:['running']
  }
  if(path==='containers' && !params.has('order') && state.sortBy==='project') {state.sortBy='server';state.descending=false}
  return { view: path === 'images' && !params.get('image') ? 'imageCatalog' : views[path] || 'accounts', workspace: params.get('workspace'), server: params.get('server'), project: params.getAll('project').length>1?params.getAll('project'):params.get('project'), ...(params.has('image') ? { image: params.getAll('image').length>1 ? params.getAll('image') : params.get('image') } : {}), ...state }
}
export function routeHash({ view, workspace, server, project, image, statuses, ...state }: RouteState) {
  if(view==='connections')return connectionsHash(state.action,state.id,state.returnTo)
  if(view==='alerts' || view==='incidents')return '#/'+view
  if(view==='organizations')return '#/organizations'
  const path = view === 'imageCatalog' ? 'images' : Object.keys(views).find(key => views[key] === view) || 'workspaces'
  const params = new URLSearchParams()
  if(Array.isArray(statuses)) for(const status of normalizeStatuses(statuses).length?normalizeStatuses(statuses):['all']) params.append('status',status)
  if (workspace) params.set('workspace', workspace)
  if (server) params.set('server', server)
  for(const value of [...new Set(Array.isArray(project)?project:[project])]) if(value)params.append('project',value)
  for(const value of [...new Set(Array.isArray(image)?image:[image])]) if(value) params.append('image',value)
  for (const [key,value] of Object.entries(readListState(new URLSearchParams(Object.entries(state).filter(([,value])=>value!==null && value!==undefined && value!=='').map(([key,value])=>[key,String(value)]))))) params.set(key==='sortBy'?'order':key,String(value))
  return `#/${path}${params.size ? `?${params}` : ''}`
}

function connectionsReturn(hash: unknown) {
  return typeof hash==='string' && /^#\/(?:workspaces|servers|projects|containers|images|telemetry|alerts|incidents|organizations|tokens|desktop\/(?:mcp|controller))(?:[/?]|$)/.test(hash) ? hash : null
}

export function connectionsHash(action='list',id:string|null=null,returnTo:string|null=null) {
  if(!['list','new','edit','remove'].includes(action) || ['edit','remove'].includes(action) && !id)throw new TypeError('Invalid connection route')
  const params=new URLSearchParams()
  if(connectionsReturn(returnTo))params.set('returnTo',returnTo)
  const path=action==='list'?'':action==='new'?'/new':'/'+encodeURIComponent(id)+'/'+action
  return '#/desktop/connections'+path+(params.size?'?'+params:'')
}

export function managementHash(resource, action = 'new', id = null, parent = null, returnTo = null) {
  if (!['workspaces','servers','projects','containers'].includes(resource) || !['new','edit','delete'].includes(action)) throw new TypeError('Invalid management route')
  const params = new URLSearchParams()
  if(parent) params.set('parent',parent)
  if(managementReturn(returnTo)) params.set('returnTo',returnTo)
  return `#/manage/${resource}/${action === 'new' ? 'new' : `${encodeURIComponent(id)}/${action}`}${params.size ? `?${params}` : ''}`
}

export function inventoryReturn(hash) {
  return typeof hash==='string' && /^#\/(workspaces|servers|projects|containers|images)(\?|$)/.test(hash) ? hash : null
}
function managementReturn(hash) {
  return inventoryReturn(hash) || (typeof hash==='string' && /^#\/telemetry(?:\?|$)/.test(hash) ? hash : null)
}
function readListState(params: URLSearchParams): ListState {
  const state: ListState={}
  if(params.get('operatingSystem') && !['null','undefined'].includes(params.get('operatingSystem'))) state.operatingSystem=params.get('operatingSystem')
  if(params.get('search') && !['null','undefined'].includes(params.get('search'))) state.search=params.get('search')
  if(['all','docker','pending','credential'].includes(params.get('coverage'))) state.coverage=params.get('coverage')
  if(['VPS','Backup','SMTP Relay','other'].includes(params.get('serverType'))) state.serverType=params.get('serverType')
  for(const key of ['includeRemoved','onlyWithServers','descending']) if(['true','false'].includes(params.get(key))) state[key]=params.get(key)==='true'
  for(const key of ['page','perPage']) if(/^\d+$/.test(params.get(key)||'') && Number(params.get(key))>0 && Number.isSafeInteger(Number(params.get(key)))) state[key]=Number(params.get(key))
  const order=params.get('order') || params.get('sortBy')
  if(order && /^[a-zA-Z_]+$/.test(order)) state.sortBy=order
  return state
}

export function bulkDeleteHash(ids: string[],returnTo: string) {
  const params=new URLSearchParams()
  for(const id of [...new Set(ids)].slice(0,100)) if(/^[a-z0-9]{15}$/.test(id))params.append('id',id)
  if(inventoryReturn(returnTo))params.set('returnTo',returnTo)
  return '#/manage/containers/bulk-delete?'+params
}
