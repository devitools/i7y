import { normalizeStatuses } from './container-status.js'
const resources = new Set(['workspaces','servers','projects','containers','images'])
export function inventoryQuery(client, resource, options={}) {
  if (!resources.has(resource)) throw new TypeError('Invalid inventory resource')
  const {page=1,perPage=10,search='',workspace=null,server=null,project=null,image=null,statuses=null,includeRemoved=false,coverage='all',serverType=null,operatingSystem=null,onlyWithServers=false,sortBy=null,descending=false,id=null,ids=null,legacyOrder=null}=options
  const filters=[]
  const add=(expression,values)=>filters.push(client.filter(expression,values))
  if (resource==='images') add('workspace_login = {:workspace}',{workspace:workspace || ''})
  else if (workspace) add('workspace_login = {:workspace}',{workspace})
  if (search?.trim()) add('search_text ~ {:search}',{search:search.trim()})
  if (server) add('server_id = {:server}',{server})
  const projects=[...new Set((Array.isArray(project)?project:[project]).filter(value=>typeof value==='string' && value))]
  if(projects.length) filters.push('('+projects.map(value=>client.filter('project_id = {:project}',{project:value})).join(' || ')+')')
  const images=[...new Set((Array.isArray(image)?image:[image]).filter(value=>typeof value==='string' && value))]
  if(images.length) filters.push('('+images.map(value=>client.filter('image = {:image}',{image:value})).join(' || ')+')')
  if(resource==='containers' && !id) {
    if(Array.isArray(statuses)) {
      const selected=normalizeStatuses(statuses)
      if(statuses.length && !selected.length) filters.push("id = ''")
      if(selected.length) filters.push('('+selected.map(state=>state==='missing'?"(state = 'missing' || state = 'removed')":state==='unknown'?"(state = 'unknown' || state = '')":client.filter('state = {:state}',{state})).join(' || ')+')')
    } else if(!includeRemoved) filters.push("state != 'missing' && state != 'removed'")
  }
  if (id) add('id = {:id}',{id})
  if(Array.isArray(ids)) filters.push(ids.length?'('+[...new Set(ids)].map(id=>client.filter('id = {:id}',{id})).join(' || ')+')':"id = ''")
  if (legacyOrder!==null) add('sort_order = {:order}',{order:legacyOrder})
  if (resource==='workspaces' && onlyWithServers) filters.push('active_count > 0')
  if (resource==='servers') {
    if(operatingSystem==='unknown') filters.push("os_name = ''")
    else if(operatingSystem) add('os_name = {:os}',{os:operatingSystem})
    if (serverType==='other') filters.push("type != 'VPS'")
    else if (serverType) add('type = {:type}',{type:serverType})
    if (coverage==='docker') filters.push('container_count > 0')
    if (coverage==='pending') filters.push("type = 'VPS' && inventory_known = false")
    if (coverage==='credential') filters.push('no_credential = 1')
  }
  const sorting={workspaces:{name:'workspace_login',count:'server_count',containers:'container_count'},servers:{name:'name',account:'workspace_login',ip:'ip',inventory:'container_count'},projects:{name:'name',containers:'container_count'},containers:{name:'name',state:'state',image:'image',project:'project_name',server:'server_name',ip:'ip',account:'workspace_login'},images:{name:'name',containers:'count'}}
  const field=sorting[resource][sortBy]
  const tieBreak=resource==='containers' && sortBy==='project'?',name,id':resource==='containers' && sortBy==='server'?',project_name,name,id':',id'
  const serverSort=field?`type_order,${descending?'-':''}${field}${field==='name'?'':',name'},id`:'type_order,name,id'
  return {page:Math.max(1,page),perPage:Math.min(100,Math.max(1,perPage)),options:{filter:filters.join(' && '),sort:resource==='servers'?serverSort:field ? `${descending?'-':''}${field}${tieBreak}` : resource==='images'?'-count,name,id':resource==='workspaces'?'workspace_login,id':resource==='containers'?'server_name,project_name,name,id':'sort_order,id',fields:'id,payload',requestKey:null}}
}
