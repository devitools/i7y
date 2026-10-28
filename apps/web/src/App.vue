<script setup>
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue'
import { watch } from 'vue'
import en from 'quasar/lang/en-US'
import ptBR from 'quasar/lang/pt-BR'
import uk from 'quasar/lang/uk'
import { dark } from './theme'
import { locale, t, languageOptions } from './i18n'
import MainLayout from './layouts/MainLayout.vue'
import ServerStats from './components/ServerStats.vue'
import MetricScaleLegend from './components/MetricScaleLegend.vue'
const TelemetryPage=defineAsyncComponent(()=>import('./components/TelemetryPage.vue'))
const AgentInstallPage=defineAsyncComponent(()=>import('./components/AgentInstallPage.vue'))
import ApiTokensPage from './components/ApiTokensPage.vue'
import OrganizationsPage from './components/OrganizationsPage.vue'
import InvitationPage from './components/InvitationPage.vue'
import BulkDeletePage from './components/BulkDeletePage.vue'
import ManagementPage from './components/ManagementPage.vue'
import RecordDetailDialog from './components/RecordDetailDialog.vue'
import { useQuasar } from 'quasar'
import { protectedRoute } from './auth-routing.js'
import { readRoute, routeHash, managementHash, bulkDeleteHash } from './routes'
import { inventoryPage, inventoryScope, inventoryProjectOptions, inventoryServerStats, inventoryOperatingSystems, invalidateInventory, management, authStore, activeOrganization, organizationChoices, globalAdmin, loadOrganizations, setOrganization } from './api'
import { containerStatusOptions } from './container-status.js'
import { matches, hasInventory } from './inventory'
const q = useQuasar()
const currentRoute = ref(readRoute(window.location.hash))
const session = ref(null)
const authReady = ref(false)
let expiryTimer = null
let inventoryRefreshTimer = null
let inventoryRequest = 0
let sidebarRequest = 0
let filterTimer = null
let returnTo = '#/workspaces'
let applyingRoute = false
const canEdit = computed(() => !!activeOrganization.value && authStore.isValid && (globalAdmin.value || ['admin','editor'].includes(organizationChoices.value.find(r=>r.id===activeOrganization.value)?.role)))
async function changeOrganization(id, target = '#/workspaces') {
  clearPrivateState()
  setOrganization(id)
  account.value=null;search.value='';coverage.value='all'
  window.history.replaceState(null,'',target)
  applyRoute()
  await loadWorkspaces()
}
const managementView = computed(() => ['manage','login','bulkDelete'].includes(view.value))
const containerView=computed(()=>['containers','images'].includes(view.value))
const selectedContainers=ref([])
function reviewBulkDelete() {window.location.hash=bulkDeleteHash(selectedContainers.value.map(row=>row.id),listHash())}
const resource = computed(() => ({accounts:'workspaces',servers:'servers',projects:'projects',containers:'containers',images:'containers'})[view.value])
function manage(action = 'new', row = null) {
  const parent = resource.value === 'servers' ? activeAccount.value?.id : resource.value === 'projects' ? serverScope.value?.id : resource.value === 'containers' ? projectScope.value?.id : null
  window.location.hash = managementHash(resource.value,action,row?.id,parent,listHash())
}
function backFromManagement() {
  if(currentRoute.value.returnTo) { window.location.hash=currentRoute.value.returnTo; return }
  go(({workspaces:'accounts',servers:'servers',projects:'projects',containers:'containers'})[currentRoute.value.resource] || 'accounts') }
async function saved(resource) {
  if (resource === 'workspaces') onlyWithServers.value=false
  invalidateInventory()
  if (['workspaces','servers'].includes(resource)) loadWorkspaces(true)
  backFromManagement()
}
const organizationError=ref(''),organizationLoading=ref(false)
async function initializeOrganizations() {
  organizationLoading.value=true;organizationError.value=''
  try {await loadOrganizations();return true}
  catch {organizationError.value=t('Unable to load organizations. Your session is still active.');return false}
  finally {organizationLoading.value=false}
}
async function retryOrganizations() {
  if(await initializeOrganizations()){applyRoute();await loadWorkspaces()}
}
async function signedIn() {
  session.value=authStore.record
  await initializeOrganizations()
  window.history.replaceState(null,'',returnTo)
  applyRoute()
  await loadWorkspaces()
}
function clearPrivateState() {
  inventoryRequest++
  selectedContainers.value=[]
  invalidateInventory()
  sidebarRequest++
  rows.value=[]
  accounts.value=[]
  workspaceRequest++
  workspaceChoices.value=[]
  workspaceTotal.value=0
  imageChoices.value=[]
  serverChoices.value=[]
  projectChoices.value=[]
  serverLookupRequest++;projectLookupRequest++
  projectLookupBusy.value=false;projectLookupPage.value=1;projectLookupTotal.value=0
  detailProjects.value=[]
  detailContainers.value={}
  pagination.value={...pagination.value,rowsNumber:0}
  sidebarTotal.value=0
  selected.value=null
  containerDetails.value=null
  serverScope.value=null
  projectScope.value=null
  projectScopes.value=[];projectSelection.value=[]
  drawer.value=false
  containerDialog.value=false
  error.value=''
}
function signOut() {
  returnTo='#/workspaces'
  management.signOut()
  window.history.replaceState(null,'','#/login')
  applyRoute()
}
let stopAuth = null
watch(locale, value => q.lang.set(({en,'pt-BR':ptBR,uk})[value]), { immediate: true })
const accounts = ref([]), loading = ref(true), error = ref(''), search = ref(''), account = ref(null), coverage = ref('all'), serverType = ref(null), operatingSystem = ref(null), operatingSystems = ref([]), view = ref(currentRoute.value.view), selected = ref(null), drawer = ref(false), mobileMenu = ref(false)
const nav = computed(() => [{id:'organizations',name:t('Organizations'),icon:'business'},{id:'accounts',name:t('Workspaces'),icon:'account_balance_wallet'},{id:'servers',name:t('Servers'),icon:'dns'},{id:'projects',name:t('Projects'),icon:'folder_open'},{id:'containers',name:t('All containers'),icon:'layers'},{id:'imageCatalog',name:t('Images'),icon:'view_in_ar'},{id:'telemetry',name:t('Telemetry'),icon:'monitor_heart'}])
const containerDetails = ref(null), containerDialog = ref(false)
const containerFields = computed(() => containerDetails.value ? [{label:t('Image'),value:containerDetails.value.image},{label:t('Project / directory'),value:containerDetails.value.project},{label:t('Server'),value:containerDetails.value.server.name || containerDetails.value.server.ip},{label:t('Workspace'),value:containerDetails.value.server.account}] : [])
const imageSearch = ref('')
const imageScope = ref([]), retainedSearch = ref(null)
const serverScope = ref(null), projectScope = ref(null)
const projectScopes=ref([]),projectSelection=ref([]),projectLookupPage=ref(1),projectLookupTotal=ref(0),projectLookupSearch=ref(''),projectLookupBusy=ref(false)
function containerStateLabel(row) {
 const state=row.state || row.telemetry?.state || 'unknown'
 return t(({missing:'Removed',removed:'Removed',running:row.telemetry?.health==='unhealthy'?'Unhealthy':row.telemetry?.health==='starting'?'Starting':'Running',exited:'Stopped',dead:'Dead',paused:'Paused',restarting:'Restarting',created:'Created',removing:'Removing'})[state] || 'Unknown')
}
function containerStateColor(row) {
 const state=row.state || row.telemetry?.state || 'unknown'
 return ['missing','removed','unknown'].includes(state)?'grey-7':state==='running' && !['unhealthy','starting'].includes(row.telemetry?.health)?'positive':'warning'
}
const onlyWithServers = ref(true)
const containerStatuses = ref(['running'])
const statusOptions=computed(()=>containerStatusOptions.map(option=>({...option,label:t(option.label)})))
const statusSummary=computed(()=>containerStatuses.value.length?statusOptions.value.filter(option=>containerStatuses.value.includes(option.value)).map(option=>option.label).slice(0,2).join(', ')+(containerStatuses.value.length>2?` +${containerStatuses.value.length-2}`:''):t('All statuses'))
const rows = ref([])
const pagination = ref({page:1,rowsPerPage:10,rowsNumber:0,sortBy:currentRoute.value.view==='containers'?'server':currentRoute.value.view==='servers'?'name':null,descending:false})
const sidebarPage=ref(1), sidebarTotal=ref(0)
const visibleWorkspaces = computed(() => accounts.value)
const title = computed(() => view.value === 'images' ? t('Image usage') : nav.value.find(n => n.id === view.value)?.name)
const activeAccount = computed(() => accounts.value.find(a => a.login === account.value))
const serverChoices=ref([]), projectChoices=ref([])
let serverLookupRequest=0, projectLookupRequest=0
const serverOptions=computed(()=>[{label:t('All servers'),value:null},...new Map([serverScope.value,...serverChoices.value].filter(Boolean).map(row=>[row.id,{label:row.name || row.ip,value:row.id,caption:[row.ip,row.account].filter(Boolean).join(' · ')}])).values()])
const projectOptions=computed(()=>[...new Map([...projectScopes.value,...projectChoices.value].map(row=>[row.id,{label:row.name,value:row.id,caption:[row.path,row.server?.name].filter(Boolean).join(' · ')}])).values()].sort((a,b)=>a.label.localeCompare(b.label,'en',{sensitivity:'base'}) || a.caption.localeCompare(b.caption) || a.value.localeCompare(b.value)))
const workspaceChoices=ref([]), imageChoices=ref([])
const workspaceSearch=ref(''), workspacePage=ref(1), workspaceTotal=ref(0), workspaceBusy=ref(false)
let workspaceRequest=0
const imageOptions = computed(() => [...new Set([...imageScope.value,...imageChoices.value.map(row=>row.name)])].sort((a,b)=>a.localeCompare(b,'en',{sensitivity:'base'})).map(name=>({label:name,value:name})))
const accountOptions = computed(() => [{label:t('All workspaces'),value:null},...workspaceChoices.value.map(a=>({label:a.login,value:a.login,count:a.count}))])
const serverTypeOptions = computed(()=>[{label:t('All types'),value:null},{label:'VPS',value:'VPS'},{label:t('Backup'),value:'Backup'},{label:'SMTP Relay',value:'SMTP Relay'},{label:t('Other services'),value:'other'}])
async function loadOperatingSystems(){try{operatingSystems.value=await inventoryOperatingSystems(account.value)}catch{operatingSystems.value=[]}}
const operatingSystemOptions=computed(()=>[{label:t('All operating systems'),value:null},{label:t('Not reported'),value:'unknown'},...operatingSystems.value.map(value=>({label:value,value}))])
const coverageOptions = computed(() => [{ label:t('All servers'), value:'all' },{ label:t('With containers'), value:'docker' },{ label:t('Pending review'), value:'pending' },{ label:t('No credential reference'), value:'credential' }])
async function loadWorkspaces(force=false,append=false) {
  const request=++sidebarRequest
  if(!activeOrganization.value)return
  const page=append?sidebarPage.value+1:1
  try {
    const result=await inventoryPage('workspaces',{page,perPage:50,onlyWithServers:onlyWithServers.value},{force})
    if(request!==sidebarRequest || !session.value)return
    accounts.value=append?[...accounts.value,...result.items]:result.items
    sidebarPage.value=page;sidebarTotal.value=result.totalItems
  } catch { if(session.value)error.value='Unable to load the inventory. Check that PocketBase is running and try again.' }
}
async function loadWorkspaceChoices(append=false) {
  const request=++workspaceRequest
  if(!activeOrganization.value)return
  const page=append?workspacePage.value+1:1
  workspaceBusy.value=true
  try {
    const result=await inventoryPage('workspaces',{search:workspaceSearch.value,onlyWithServers:onlyWithServers.value,page,perPage:50})
    if(request!==workspaceRequest || !session.value)return
    workspaceChoices.value=append?[...workspaceChoices.value,...result.items]:result.items
    workspacePage.value=page;workspaceTotal.value=result.totalItems
  } finally {if(request===workspaceRequest)workspaceBusy.value=false}
}
async function workspaceLookup(value,done) {
  workspaceSearch.value=value
  try {await loadWorkspaceChoices();done(()=>{})} catch {done(()=>{workspaceChoices.value=[];workspaceTotal.value=0})}
}
async function serverLookup(value,done) {
  const request=++serverLookupRequest
  try {
    const result=await inventoryPage('servers',{search:value,workspace:account.value,serverType:'VPS',perPage:50})
    if(request===serverLookupRequest) done(()=>serverChoices.value=result.items)
    else done(()=>{})
  } catch {done(()=>serverChoices.value=[])}
}
async function loadProjectChoices(append=false) {
  const request=++projectLookupRequest
  const page=append?projectLookupPage.value+1:1
  projectLookupBusy.value=true
  try {
    const result=await inventoryProjectOptions({search:projectLookupSearch.value,matchingSearch:search.value,workspace:account.value,server:serverScope.value?.id,image:imageScope.value,statuses:containerStatuses.value,page})
    if(request!==projectLookupRequest)return
    projectChoices.value=append?[...projectChoices.value,...result.items]:result.items
    projectLookupPage.value=page;projectLookupTotal.value=result.totalItems
  } finally {if(request===projectLookupRequest)projectLookupBusy.value=false}
}
async function projectLookup(value,done) {
  projectLookupSearch.value=value
  try {await loadProjectChoices();done(()=>{})} catch {done(()=>projectChoices.value=[])}
}
function changeProjects(ids) {
  projectSelection.value=ids || []
  projectScopes.value=[...projectScopes.value,...projectChoices.value].filter((row,index,rows)=>projectSelection.value.includes(row.id) && rows.findIndex(item=>item.id===row.id)===index)
  projectScope.value=projectScopes.value.length===1?projectScopes.value[0]:null
  selectedContainers.value=[]
  pagination.value.page=1
  syncListUrl()
  loadScreen()
}
function changeContainerScope(kind,id) {
  const route=readRoute(listHash())
  if(kind==='server') {route.server=id;route.project=null}
  else {
    route.project=id
    if(id) route.server=projectChoices.value.find(row=>row.id===id)?.server?.id || projectScope.value?.server?.id || route.server
  }
  route.page=1
  window.location.hash=routeHash(route)
}
async function imageLookup(value,done) {
  try {const result=await inventoryPage('images',{search:value,workspace:account.value,perPage:50,sortBy:'name'});done(()=>imageChoices.value=result.items)} catch {done(()=>imageChoices.value=[])}
}
const columns = computed(() => {
  if (view.value==='imageCatalog') return [{name:'name',label:t('Image'),field:'name',align:'left',sortable:true},{name:'containers',label:t('Containers'),field:'count',align:'left',sortable:true},{name:'action',label:'',field:'key'}]
  if (view.value==='accounts') return [{name:'name',label:t('Workspace'),field:'login',align:'left',sortable:true},{name:'provider',label:t('Provider'),field:'provider',align:'left'},{name:'count',label:'VPS',field:'count',align:'left',sortable:true},{name:'containers',label:t('Containers'),field:'containers',align:'left',sortable:true},{name:'action',label:'',field:'key'}]
  if (view.value==='projects') return [{name:'name',label:t('Project / directory'),field:'name',align:'left',sortable:true},{name:'server',label:t('Server'),field:r=>r.server.name,align:'left',sortable:true},{name:'account',label:t('Workspace'),field:r=>r.server.account,align:'left'},{name:'containers',label:t('Containers'),field:'container_count',align:'left',sortable:true},{name:'action',label:'',field:'key'}]
  if (view.value==='images') return [{name:'state',label:t('State'),field:'state',align:'left',sortable:true},{name:'name',label:t('Container'),field:'name',align:'left',sortable:true},{name:'project',label:t('Project / directory'),field:'project',align:'left',sortable:true},{name:'image',label:t('Image'),field:'image',align:'left',sortable:true},{name:'server',label:t('Server'),field:r=>r.server.name || r.server.ip,align:'left',sortable:true},{name:'ip',label:t('IP address'),field:r=>r.server.ip,align:'left',sortable:true},{name:'action',label:'',field:'key'}]
  if (view.value==='containers') return [{name:'state',label:t('State'),field:'state',align:'left',sortable:true},{name:'name',label:t('Container'),field:'name',align:'left',sortable:true},{name:'project',label:t('Project'),field:'project',align:'left',sortable:true},{name:'image',label:t('Image'),field:'image',align:'left',sortable:true},{name:'server',label:t('Server'),field:r=>r.server.name,align:'left',sortable:true},{name:'ip',label:t('IP address'),field:r=>r.server.ip,align:'left',sortable:true},{name:'action',label:'',field:'key'}]
  return [{name:'name',label:t('Server'),field:'name',align:'left',sortable:true},{name:'account',label:t('Workspace'),field:'account',align:'left',sortable:true},{name:'ip',label:t('IP address'),field:'ip',align:'left',sortable:true},{name:'status',label:t('Status'),field:'status',align:'left'},{name:'inventory',label:t('Containers'),field:'container_count',align:'left',sortable:true},{name:'action',label:'',field:'key'}]
})
const detailProjects = ref([]), detailSearch = ref(''), detailPage=ref(1), detailTotal=ref(0), detailLoading=ref(false)
const detailContainers=ref({}), detailContainerPages=ref({})
let detailRequest=0
async function loadDetails(force=false) {
  if(!selected.value || !drawer.value)return
  const request=++detailRequest
  detailLoading.value=true
  try {
    if(force) {
      const summary=await inventoryPage('servers',{id:selected.value.id,perPage:1},{force:true})
      if(request!==detailRequest || !drawer.value)return
      if(summary.items[0])selected.value=summary.items[0]
      await Promise.all(Object.keys(detailContainers.value).map(id=>loadProjectContainers({id},detailContainerPages.value[id] || 1,true)))
    }
    const result=await inventoryPage('projects',{server:selected.value.id,page:detailPage.value,perPage:10,search:detailSearch.value},{force})
    if(request!==detailRequest || !drawer.value)return
    detailProjects.value=result.items;detailTotal.value=result.totalItems
  } catch {q.notify({type:'negative',message:t('Unable to load the inventory. Check that PocketBase is running and try again.')})}
  finally {if(request===detailRequest)detailLoading.value=false}
}
async function loadProjectContainers(project,page=1,force=false) {
  const server=selected.value?.id
  try {
    const result=await inventoryPage('containers',{project:project.id,page,perPage:10},{force})
    if(selected.value?.id!==server || !drawer.value)return
    detailContainers.value={...detailContainers.value,[project.id]:result}
    detailContainerPages.value={...detailContainerPages.value,[project.id]:page}
  } catch {q.notify({type:'negative',message:t('Unable to load the inventory. Check that PocketBase is running and try again.')})}
}
watch(drawer,value=>{detailRequest++;if(value){detailProjects.value=[];detailContainers.value={};detailPage.value=1;loadDetails()}})
watch(detailPage,()=>loadDetails())
watch(detailSearch,()=>{detailPage.value=1;loadDetails()})
function applyRoute() {
  const guarded = protectedRoute(window.location.hash,!!session.value)
  if (guarded.returnTo) returnTo=guarded.returnTo
  if (window.location.hash !== guarded.hash) window.history.replaceState(null,'',guarded.hash)
  clearTimeout(filterTimer)
  serverChoices.value=[];projectChoices.value=[]
  serverLookupRequest++;projectLookupRequest++
  projectLookupBusy.value=false;projectLookupPage.value=1;projectLookupTotal.value=0
  selectedContainers.value=[]
  applyingRoute = true
  const route = readRoute(window.location.hash)
  currentRoute.value = route
  view.value = route.view
  imageScope.value = route.image ? (Array.isArray(route.image)?route.image:[route.image]) : []
  account.value = route.workspace || null
  serverScope.value = null
  projectScope.value = null
  projectScopes.value=[]
  projectSelection.value=route.project?(Array.isArray(route.project)?route.project:[route.project]):[]
  if (view.value === 'images') { serverScope.value=null; projectScope.value=null }
  search.value = route.search ?? retainedSearch.value ?? ''
  retainedSearch.value = null
  coverage.value = route.coverage || 'all'
  serverType.value = route.serverType || null
  operatingSystem.value = route.operatingSystem || null
  containerStatuses.value = route.statuses ?? ['running']
  onlyWithServers.value = route.onlyWithServers ?? onlyWithServers.value
  drawer.value = false
  containerDialog.value = false
  mobileMenu.value = false
  pagination.value={...pagination.value,page:route.page || 1,rowsPerPage:[10,25,50,100].includes(route.perPage)?route.perPage:10,rowsNumber:0,sortBy:route.sortBy || (view.value==='containers'?'server':view.value==='servers'?'name':null),descending:route.descending ?? false}
  rows.value=[]
  applyingRoute = false
  if(/[?&](search|operatingSystem)=(null|undefined)(&|$)/.test(window.location.hash))syncListUrl()
  loadScreen()
}
function go(view, workspace = null, server = null, project = null, image = null) {
  const hash = routeHash({view, workspace, server:server?.key, project:project?.key, image})
  if (window.location.hash === hash) applyRoute()
  else window.location.hash = hash
}
function navigate(id) { go(id) }
function chooseAccount(login) { go('servers', login) }
function openRow(row) {
  if (view.value === 'imageCatalog') return go('images',account.value,null,null,row.name)
  if (view.value === 'accounts') return chooseAccount(row.login)
  if (view.value === 'servers' && row.type !== 'VPS') { selected.value=row; drawer.value=true; return }
  if (view.value === 'servers') return go('projects', row.account, row)
  if (view.value === 'projects') return go('containers', row.server.account, row.server, row)
  containerDetails.value = row
  containerDialog.value = true
}
function backToServers() { go('servers', account.value) }
function backToProjects() { go('projects', account.value, serverScope.value) }
function changeWorkspace(login) { retainedSearch.value=search.value; go(view.value, login, null, null, imageScope.value) }
function changeImage(images) {
  imageScope.value=images || []
  pagination.value.page=1
  if(view.value==='images' && !imageScope.value.length) view.value='containers'
  syncListUrl()
  loadScreen()
}
function openImage(image) { go('images', null, null, null, image) }
function clearFilters() { go(view.value === 'images' ? 'containers' : view.value) }

async function loadScreen(force=false) {
  const request=++inventoryRequest
  const kind=resource.value || (view.value==='imageCatalog'?'images':null)
  if (!session.value || !activeOrganization.value || !kind) {loading.value=false;return}
  loading.value=true;error.value=''
  const route=currentRoute.value
  try {
    const server=await inventoryScope('servers',route.server,route.workspace)
    const projectKeys=route.project?(Array.isArray(route.project)?route.project:[route.project]):[]
    const projects=projectKeys.length>1?(await inventoryPage('projects',{ids:projectKeys,perPage:100})).items:projectKeys.length?[await inventoryScope('projects',projectKeys[0],route.workspace,server?.id)]:[]
    const project=projects.length===1?projects[0]:null
    if(request!==inventoryRequest || !session.value)return
    if((route.server&&!server)||projects.some(row=>!row)||projects.length!==projectKeys.length)throw new Error('Scope not found')
    serverScope.value=server;projectScope.value=project;projectScopes.value=projects;projectSelection.value=projects.map(row=>row.id)
    const result=await inventoryPage(kind,{page:pagination.value.page,perPage:pagination.value.rowsPerPage,sortBy:pagination.value.sortBy,descending:pagination.value.descending,search:search.value,workspace:account.value,server:server?.id,project:projects.map(row=>row.id),image:imageScope.value,statuses:containerStatuses.value,coverage:coverage.value,serverType:kind==='servers'?serverType.value:null,operatingSystem:kind==='servers'?operatingSystem.value:null,onlyWithServers:kind==='workspaces'&&onlyWithServers.value},{force})
    if(request!==inventoryRequest || !session.value)return
    if(kind==='servers') {
      let stats
      try {stats=await inventoryServerStats(result.items.filter(row=>row.type==='VPS').map(row=>row.id),{force})}catch{stats=null}
      if(request!==inventoryRequest || !session.value)return
      result.items=result.items.map(row=>({...row,stats:stats?.[row.id],statsError:stats===null}))
    }
    rows.value=result.items
    selectedContainers.value=selectedContainers.value.filter(selected=>result.items.some(row=>row.id===selected.id))
    pagination.value={...pagination.value,rowsNumber:result.totalItems}
    if(pagination.value.page>Math.max(1,result.totalPages)){pagination.value.page=Math.max(1,result.totalPages);syncListUrl();return loadScreen()}
  } catch {if(request===inventoryRequest&&session.value)error.value='Unable to load the inventory. Check that PocketBase is running and try again.'}
  finally {if(request===inventoryRequest)loading.value=false}
}
function refresh() { return drawer.value?loadDetails(true):loadScreen(true) }
function listHash() {
  return routeHash({view:view.value,workspace:account.value,server:currentRoute.value.server,project:projectSelection.value,image:imageScope.value,search:search.value,coverage:coverage.value,serverType:serverType.value,operatingSystem:operatingSystem.value,statuses:containerStatuses.value,onlyWithServers:onlyWithServers.value,page:pagination.value.page,perPage:pagination.value.rowsPerPage,sortBy:pagination.value.sortBy || '',descending:pagination.value.descending})
}
function syncListUrl() {
  if(!resource.value && view.value!=='imageCatalog') return
  window.history.replaceState(null,'',listHash())
  currentRoute.value=readRoute(window.location.hash)
}
function tableRequest({pagination:next}) {selectedContainers.value=[];pagination.value={...pagination.value,...next};syncListUrl();loadScreen()}
watch([search,coverage,serverType,operatingSystem,containerStatuses],()=>{if(applyingRoute)return;selectedContainers.value=[];pagination.value.page=1;syncListUrl();clearTimeout(filterTimer);filterTimer=setTimeout(()=>loadScreen(),300)},{flush:'sync'})
watch(onlyWithServers,()=>{if(applyingRoute)return;syncListUrl();workspaceChoices.value=[];workspaceTotal.value=0;loadWorkspaceChoices().catch(()=>{});loadWorkspaces();if(view.value==='accounts'){pagination.value.page=1;syncListUrl();loadScreen()}},{flush:'sync'})

async function copy(text) { try { await navigator.clipboard.writeText(text); q.notify({message:t('Copied to clipboard'),type:'positive',position:'bottom-right',timeout:1500}) } catch { q.notify({message:t('Unable to copy. Select the text manually.'),type:'negative'}) } }
function exportData() { const url=URL.createObjectURL(new Blob([JSON.stringify(rows.value,null,2)],{type:'application/json'})); const a=document.createElement('a'); a.href=url; a.download=`${resource.value || 'images'}-page-${pagination.value.page}.json`; a.click(); URL.revokeObjectURL(url) }
onMounted(async () => {
  window.addEventListener('hashchange', applyRoute)
  stopAuth = authStore.onChange(() => {
    session.value=authStore.isValid && authStore.record?.collectionName === 'users' ? authStore.record : null
    if (!session.value) { clearPrivateState(); if (authReady.value) applyRoute() }
  })
  if (authStore.isValid && authStore.record?.collectionName === 'users') {
    try { await management.refreshSession(); session.value=authStore.record }
    catch { management.signOut() }
  } else management.signOut()
  if(session.value) await initializeOrganizations()
  authReady.value=true
  applyRoute()
  if (session.value) await loadWorkspaces()
  inventoryRefreshTimer=setInterval(()=>{if(session.value && !document.hidden && !loading.value && !managementView.value && !selectedContainers.value.length && ['containers','images'].includes(view.value)) loadScreen(true)},10000)
  expiryTimer=setInterval(() => { if (session.value && !authStore.isValid) management.signOut() },1000)
})
onUnmounted(() => { window.removeEventListener('hashchange', applyRoute); stopAuth?.(); clearInterval(expiryTimer); clearInterval(inventoryRefreshTimer); clearTimeout(filterTimer) })
</script>

<template>
  <q-layout v-if="!authReady || !session || view==='login' || view==='invite'" view="lHh Lpr lFf">
    <q-header bordered :class="dark ? 'bg-dark text-white' : 'bg-white text-grey-9'"><q-toolbar><q-icon name="hub" color="primary" size="28px" class="q-mr-sm"/><q-toolbar-title class="text-weight-bold">i7y</q-toolbar-title><q-select v-model="locale" :options="languageOptions" emit-value map-options dense borderless aria-label="Language / Idioma / Мова" style="width:64px" class="q-mr-sm" /><q-btn flat round dense :icon="dark ? 'light_mode' : 'dark_mode'" :aria-label="t('Toggle theme')" @click="dark=!dark" /></q-toolbar></q-header>
    <q-page-container><q-page v-if="!authReady" class="flex flex-center"><q-spinner color="primary" size="36px" :aria-label="t('Loading')" /></q-page><InvitationPage v-else-if="view==='invite'" :key="currentRoute.token" :token="currentRoute.token" @accepted="signedIn" /><ManagementPage v-else :route="{view:'login'}" :can-edit="false" :authenticated="false" @signed-in="signedIn" /></q-page-container>
  </q-layout>
  <MainLayout v-else :nav="nav" :active-view="view==='images'?'imageCatalog':view" :active-workspace="account" :workspaces="visibleWorkspaces" :more-workspaces="accounts.length<sidebarTotal" @more-workspaces="loadWorkspaces(false,true)" :loading="loading" :error="error" v-model:only-with-servers="onlyWithServers" @navigate="navigate" @workspace="chooseAccount">
      <template #organization>
        <q-select :model-value="activeOrganization" @update:model-value="changeOrganization" :options="organizationChoices.map(r=>({label:r.name,value:r.id}))" emit-value map-options outlined dense dark :label="t('Organization')" />
      </template>
      <template #session>
        <q-btn flat no-caps icon="account_circle" :label="session.email" class="session-button" :aria-label="t('Session options')" aria-haspopup="menu">
          <q-menu anchor="bottom right" self="top right" auto-close>
            <q-list class="session-menu" role="menu"><q-item-label header>{{session.email}}</q-item-label><q-item clickable href="#/tokens" role="menuitem"><q-item-section avatar><q-icon name="key" /></q-item-section><q-item-section>{{t('API tokens')}}</q-item-section></q-item><q-separator /><q-item clickable role="menuitem" @click="signOut"><q-item-section avatar><q-icon name="power_settings_new" /></q-item-section><q-item-section>{{t('Sign out')}}</q-item-section></q-item></q-list>
          </q-menu>
        </q-btn>
      </template>
      <q-page v-if="organizationError" class="q-pa-md"><q-banner class="bg-red-1 text-negative" role="alert">{{organizationError}}<template #action><q-btn flat no-caps :label="t('Try again')" :loading="organizationLoading" @click="retryOrganizations"/></template></q-banner></q-page>
      <OrganizationsPage v-else-if="view==='organizations' || !activeOrganization" :key="activeOrganization || 'none'" :route="currentRoute" @select="(id,path)=>changeOrganization(id,path)" @changed="clearPrivateState();loadWorkspaces(true)" />
      <BulkDeletePage v-else-if="view==='bulkDelete'" :route="currentRoute" :can-edit="canEdit" @back="backFromManagement" @saved="saved"/>
      <ManagementPage v-else-if="managementView" :key="[currentRoute.view,currentRoute.resource,currentRoute.action,currentRoute.id,currentRoute.parent].join(':')" :route="currentRoute" :can-edit="canEdit" :authenticated="!!session" @back="backFromManagement" @saved="saved" @signed-in="signedIn" />
      <AgentInstallPage v-else-if="view==='agentInstall'" :key="`${activeOrganization}:${currentRoute.server}`" :server-id="currentRoute.server" />
      <TelemetryPage :can-edit="canEdit" v-else-if="view==='telemetry'" :key="`${activeOrganization}:${currentRoute.server}`" :initial-server="currentRoute.server" />
      <ApiTokensPage :key="activeOrganization" v-else-if="view==='tokens'" :route="currentRoute" :authenticated="!!session" />
      <q-page v-else class="q-pa-md inventory-page">

        <div class="page-heading"><div><h1>{{view==='images' ? imageScope.length===1 ? imageScope[0] : title : projectScope ? projectScope.name : serverScope ? serverScope.name : title}}</h1><p v-if="view==='imageCatalog'" class="page-subtitle">{{pagination.rowsNumber}} {{t('images')}} {{t('found')}}</p></div></div>
        <q-banner v-if="error" class="error-banner rounded-borders" role="alert"><template #avatar><q-icon name="cloud_off" /></template>{{t(error)}}<template #action><q-btn flat no-caps :label="t('Try again')" @click="refresh"/></template></q-banner>
        <div v-if="!['images','imageCatalog'].includes(view) && account && activeAccount" class="account-strip"><q-icon name="account_balance_wallet" size="24px"/><div><strong>{{activeAccount.login}}</strong><small>{{activeAccount.credential?.item || t('No credential reference')}}<span v-if="activeAccount.credential"> · {{activeAccount.credential.vault}}</span></small></div><q-btn flat no-caps icon="content_copy" :label="t('Copy reference')" :disable="!activeAccount.credential" @click="copy(`op://${activeAccount.credential.vault}/${activeAccount.credential.item}`)"/></div>
        <div v-if="!['images','imageCatalog'].includes(view) && (account || serverScope || projectScope)" class="drill-breadcrumb" style="display:flex;gap:12px;align-items:center;margin:0 0 20px;flex-wrap:wrap"><q-btn flat no-caps :label="t('Workspaces')" @click="navigate('accounts')"/><template v-if="account"><q-icon name="chevron_right"/><q-btn flat no-caps :label="account" @click="backToServers"/></template><template v-if="serverScope"><q-icon name="chevron_right"/><q-btn flat no-caps :label="serverScope.name || serverScope.ip" @click="backToProjects"/></template><template v-if="projectScope"><q-icon name="chevron_right"/><strong>{{projectScope.name}}</strong></template></div>
        <q-banner v-if="view==='projects' && serverScope && !hasInventory(serverScope)" class="q-mb-md">{{t('Internal inventory is pending for this server. Projects have not been confirmed yet.')}}</q-banner>
        <div v-if="view==='images'" class="drill-breadcrumb q-mb-md row items-center q-gutter-sm"><q-btn flat no-caps :label="t('Images')" @click="go('imageCatalog',account)"/><q-icon name="chevron_right"/><span>{{t('Image usage')}}</span></div>
        <q-card flat bordered class="data-panel">
          <div v-if="view!=='imageCatalog'" class="panel-heading"><div><h2>{{view==='containers' && projectScope?t('Project containers'):view==='containers' && (serverScope || account)?t('Containers'):title}}</h2><p>{{pagination.rowsNumber}} {{view==='accounts'?t('workspaces'):view==='projects'?t('projects'):view==='imageCatalog'?t('images'):['containers','images'].includes(view)?t('containers'):t('servers')}} {{t('found')}}<span v-if="search">{{' ' + t('for')}} “{{search}}”</span></p></div></div>
          <div class="inventory-controls" :class="{'container-controls':view!=='imageCatalog','image-catalog-controls':view==='imageCatalog'}"><div class="filters filter-row"><q-select v-if="view!=='accounts' && view!=='imageCatalog' && !serverScope" v-model="account" @update:model-value="changeWorkspace"  :options="accountOptions" use-input fill-input hide-selected @filter="workspaceLookup" input-debounce="300" emit-value map-options outlined dense :label="t('Workspace')" class="account-filter" :loading="workspaceBusy" popup-content-class="workspace-options">
<template #before-options><div class="q-px-md q-py-sm"><q-toggle v-model="onlyWithServers" dense size="sm" :label="t('Only workspaces with servers')" /></div><q-separator /></template>
<template #option="scope"><q-item v-bind="scope.itemProps"><q-item-section v-if="scope.opt.value" avatar><q-icon name="dns" size="20px" /></q-item-section><q-item-section><q-item-label>{{scope.opt.label}}</q-item-label></q-item-section><q-item-section v-if="scope.opt.value" side>{{scope.opt.count}}</q-item-section></q-item></template>
<template #after-options><q-item v-if="workspaceChoices.length<workspaceTotal" clickable :disable="workspaceBusy" @click="loadWorkspaceChoices(true).catch(()=>{})"><q-item-section class="text-primary">{{t('Load more')}}</q-item-section></q-item></template>
</q-select><q-select v-if="['containers','images'].includes(view)" :model-value="serverScope?.id || null" @update:model-value="id=>changeContainerScope('server',id)" :options="serverOptions" use-input fill-input hide-selected @filter="serverLookup" input-debounce="300" emit-value map-options outlined dense clearable stack-label :placeholder="serverScope?'':t('All servers')" :label="t('Server')" class="scope-filter"><template #option="scope"><q-item v-bind="scope.itemProps"><q-item-section><q-item-label>{{scope.opt.label}}</q-item-label><q-item-label caption>{{scope.opt.caption}}</q-item-label></q-item-section></q-item></template></q-select><q-select v-if="['containers','images'].includes(view)" :model-value="projectSelection" @update:model-value="changeProjects" :options="projectOptions" multiple :max-values="100" use-chips use-input @filter="projectLookup" input-debounce="300" emit-value map-options outlined dense clearable stack-label :placeholder="projectSelection.length?'':t('All projects')" :label="t('Project')" class="scope-filter project-filter" :loading="projectLookupBusy"><template #selected><div v-if="projectSelection.length" class="image-selection-summary" tabindex="0"><q-chip v-for="id in projectSelection.slice(0,1)" :key="id" dense removable class="image-selection-chip" @remove="changeProjects(projectSelection.filter(value=>value!==id))"><span class="ellipsis">{{projectOptions.find(option=>option.value===id)?.label || id}}</span></q-chip><span v-if="projectSelection.length>1" class="image-selection-more">+{{projectSelection.length-1}}</span><q-tooltip class="image-selection-tooltip"><div v-for="id in projectSelection" :key="id">{{projectOptions.find(option=>option.value===id)?.label || id}}</div></q-tooltip></div></template><template #option="scope"><q-item v-bind="scope.itemProps"><q-item-section side><q-checkbox :model-value="scope.selected" @update:model-value="scope.toggleOption(scope.opt)" @click.stop/></q-item-section><q-item-section><q-item-label>{{scope.opt.label}}</q-item-label><q-item-label caption>{{scope.opt.caption}}</q-item-label></q-item-section></q-item></template><template #after-options><q-item v-if="projectChoices.length<projectLookupTotal" clickable :disable="projectLookupBusy" @click="loadProjectChoices(true).catch(()=>{})"><q-item-section class="text-primary">{{t('Load more')}}</q-item-section></q-item></template></q-select><q-select v-if="['containers','images'].includes(view)" :model-value="imageScope" @update:model-value="changeImage" :options="imageOptions" multiple use-chips use-input :input-value="imageSearch" @input-value="value=>imageSearch=value" @filter="imageLookup" input-debounce="300" emit-value map-options outlined dense clearable stack-label :label="t('Image')" :aria-label="t('Filter by image')" :placeholder="imageScope.length ? '' : t('All images')" class="image-filter"  :class="{'image-filter-active':imageScope.length}"><template #selected><div v-if="imageScope.length" class="image-selection-summary" tabindex="0" :aria-label="imageScope.join(', ')"><q-chip v-for="image in imageScope.slice(0,1)" :key="image" dense removable class="image-selection-chip" @remove="changeImage(imageScope.filter(value=>value!==image))"><span class="ellipsis">{{image}}</span></q-chip><span v-if="imageScope.length>1" class="image-selection-more">+{{imageScope.length-1}}</span><q-tooltip class="image-selection-tooltip"><div v-for="image in imageScope" :key="image">{{image}}</div></q-tooltip></div></template><template #option="scope"><q-item v-bind="scope.itemProps"><q-item-section side><q-checkbox :model-value="scope.selected" @update:model-value="scope.toggleOption(scope.opt)" @click.stop/></q-item-section><q-item-section>{{scope.opt.label}}</q-item-section></q-item></template></q-select><q-select v-if="view==='servers'" v-model="serverType" :options="serverTypeOptions" emit-value map-options outlined dense :label="t('Type')" class="coverage-filter"/><q-select v-if="view==='servers'" v-model="operatingSystem" :options="operatingSystemOptions" @popup-show="loadOperatingSystems" emit-value map-options outlined dense :label="t('Operating system')" class="coverage-filter"/><q-select v-if="view==='servers'" v-model="coverage" :options="coverageOptions" emit-value map-options outlined dense :label="t('Show')" class="coverage-filter"/><q-select v-if="['containers','images'].includes(view)" :model-value="containerStatuses" @update:model-value="value=>containerStatuses=value || []" :options="statusOptions" multiple emit-value map-options outlined dense clearable :display-value="statusSummary" :label="t('Status')" class="scope-filter"><template #option="scope"><q-item v-bind="scope.itemProps"><q-item-section side><q-checkbox :model-value="scope.selected" @update:model-value="scope.toggleOption(scope.opt)" @click.stop/></q-item-section><q-item-section>{{scope.opt.label}}</q-item-section></q-item></template><q-tooltip>{{containerStatuses.length?statusOptions.filter(option=>containerStatuses.includes(option.value)).map(option=>option.label).join(', '):t('All statuses')}}</q-tooltip></q-select></div><div class="inventory-actions"><q-input v-model="search" outlined dense clearable :placeholder="view==='imageCatalog'?t('Search images...'):t('Search domain, IP, project or image...')" :aria-label="t('Search inventory')" class="search-input"><template #prepend><q-icon name="search" size="21px"/></template></q-input><q-select v-if="view==='imageCatalog'" v-model="account" @update:model-value="changeWorkspace"  :options="accountOptions" use-input fill-input hide-selected @filter="workspaceLookup" input-debounce="300" emit-value map-options outlined dense :label="t('Workspace')" class="catalog-workspace" :loading="workspaceBusy" popup-content-class="workspace-options">
<template #before-options><div class="q-px-md q-py-sm"><q-toggle v-model="onlyWithServers" dense size="sm" :label="t('Only workspaces with servers')" /></div><q-separator /></template>
<template #option="scope"><q-item v-bind="scope.itemProps"><q-item-section v-if="scope.opt.value" avatar><q-icon name="dns" size="20px" /></q-item-section><q-item-section><q-item-label>{{scope.opt.label}}</q-item-label></q-item-section><q-item-section v-if="scope.opt.value" side>{{scope.opt.count}}</q-item-section></q-item></template>
<template #after-options><q-item v-if="workspaceChoices.length<workspaceTotal" clickable :disable="workspaceBusy" @click="loadWorkspaceChoices(true).catch(()=>{})"><q-item-section class="text-primary">{{t('Load more')}}</q-item-section></q-item></template>
</q-select><q-btn flat no-caps color="primary" icon="filter_alt_off" :label="t('Clear all filters')" :disable="!search && !account && !serverScope && !projectSelection.length && !imageScope.length && coverage==='all' && !serverType && !operatingSystem && (containerStatuses.length===1 && containerStatuses[0]==='running')" @click="clearFilters"/><q-btn v-if="containerView && canEdit" outline no-caps color="negative" icon="delete_outline" :label="`${t('Delete selected')} (${selectedContainers.length})`" :disable="!selectedContainers.length || loading" @click="reviewBulkDelete"/><q-btn v-if="selectedContainers.length" flat no-caps :label="t('Clear selection')" @click="selectedContainers=[]"/><div class="page-actions"><q-btn v-if="serverScope" outline no-caps color="primary" icon="monitor_heart" :label="t('Telemetry')" :href="routeHash({view:'telemetry',server:serverScope.id})"/><q-btn v-if="serverScope && !projectScope" outline no-caps icon="terminal" :label="t('Install daemon')" :href="`#/servers/${serverScope.id}/agent-installation`"/><q-btn v-if="canEdit && resource" unelevated no-caps color="primary" icon="add" :label="t('Create')" @click="manage()" /><q-btn outline no-caps icon="file_download" :label="t('Export current page')" :disable="!rows.length" @click="exportData"/><q-btn unelevated no-caps color="primary" icon="refresh" :label="t('Refresh')" :loading="loading" @click="refresh"/></div></div></div>
          <q-table :key="view" flat :rows="rows" :columns="columns" row-key="key" :selection="containerView && canEdit ? 'multiple' : 'none'" v-model:selected="selectedContainers" :loading="loading" :rows-per-page-options="[10,25,50,100]" v-model:pagination="pagination" @request="tableRequest" class="inventory-table" @row-click="(_,row)=>openRow(row)" :no-data-label="t('No records found')" binary-state-sort>
            <template #header-selection="slot"><q-checkbox v-model="slot.selected" :aria-label="t('Select current page')" @click.stop/></template>
            <template #body-selection="slot"><q-checkbox v-model="slot.selected" :aria-label="`${t('Select container')} ${slot.row.name}`" @click.stop/></template>
            <template #body-cell-name="props"><q-td :props="props"><component :is="view==='servers' && props.row.type==='VPS' ? 'a' : 'button'" class="name-cell" :href="view==='servers' && props.row.type==='VPS' ? routeHash({view:'projects',workspace:props.row.account,server:props.row.id}) : undefined" :title="props.value" @click.stop="view==='servers' && props.row.type==='VPS' ? undefined : openRow(props.row)"><span class="row-icon"><q-icon :name="view==='accounts'?'account_balance_wallet':view==='projects'?'folder_open':['containers','images','imageCatalog'].includes(view)?'layers':'dns'" size="19px"/></span><span><strong>{{props.value || props.row.product || t('Unnamed service')}}</strong><small v-if="view==='servers' && props.row.type==='VPS' && props.row.stats?.operatingSystem" class="server-os-badge">{{props.row.stats.operatingSystem}}</small><small v-else-if="view!=='containers' && !(view==='servers' && props.row.type==='VPS')">{{view==='projects' ? props.row.path || t('Path not confirmed') : ['containers','images'].includes(view) ? props.row.project : view==='accounts' ? props.row.credential?.item || t('No 1Password reference') : props.row.product}}</small></span></component></q-td></template>
            <template #body-cell-ip="props"><q-td :props="props"><span class="ip-value">{{view==='servers' && props.row.type==='Backup' ? t('Not applicable') : props.value || t('Not applicable')}}</span><q-btn v-if="props.value && !(view==='servers' && props.row.type==='Backup')" flat dense round size="sm" icon="content_copy" :aria-label="`${t('Copy IP')} ${props.value}`" @click.stop="copy(props.value)"/><small v-if="view==='servers' && props.row.type==='VPS'" class="server-product">{{props.row.product}}</small></q-td></template>
            <template #header-cell-status="props"><q-th :props="props">{{t('Status')}} <MetricScaleLegend/></q-th></template>
            <template #body-cell-status="props"><q-td :props="props"><ServerStats :server="props.row"/></q-td></template>
            <template #body-cell-inventory="props"><q-td :props="props"><span v-if="props.row.type!=='VPS' || props.row.stats?.hostOnly" class="text-grey-6">{{t('Not applicable')}}</span><span v-else-if="!hasInventory(props.row)" class="pending-pill"><q-icon name="schedule" size="14px"/> {{t('Pending review')}}</span><span v-else class="container-total"><q-icon name="layers" size="17px"/>{{props.value}}<small v-if="props.row.project_count">{{t('in')}} {{props.row.project_count}} {{t('projects')}}</small><small v-else>{{t('No containers')}}</small></span></q-td></template>
            <template #body-cell-state="props"><q-td :props="props"><q-badge :color="containerStateColor(props.row)" :label="containerStateLabel(props.row)"/></q-td></template>
            <template #body-cell-image="props"><q-td :props="props"><div class="table-image"><button class="image-label image-link" :aria-label="`${t('View containers using')} ${props.value}`" @click.stop="openImage(props.value)">{{props.value}}<q-tooltip class="full-image-tooltip">{{props.value}}</q-tooltip></button><q-btn v-if="props.value" flat dense round size="sm" icon="content_copy" :aria-label="`${t('Copy image')} ${props.value}`" @click.stop="copy(props.value)"><q-tooltip>{{t('Copy image')}}</q-tooltip></q-btn></div></q-td></template>
            <template #body-cell-project="props"><q-td :props="props"><button class="name-cell" @click.stop="go('containers',props.row.server.account,props.row.server,{key:props.row.projectKey})"><span><strong>{{props.value}}</strong></span></button><div class="project-path-row"><span class="project-path" :title="props.row.path">{{props.row.path || t('Path not confirmed')}}</span><q-btn v-if="props.row.path" flat dense round size="sm" icon="content_copy" :aria-label="`${t('Copy path')} ${props.row.path}`" @click.stop="copy(props.row.path)"><q-tooltip>{{t('Copy path')}}</q-tooltip></q-btn></div></q-td></template>
            <template #body-cell-server="props"><q-td :props="props"><a class="table-link" :href="routeHash({view:'projects',workspace:props.row.server.account,server:props.row.server.key || props.row.server.id})" @click.stop @auxclick.stop>{{props.value}}</a><a class="table-link server-account" :href="routeHash({view:'servers',workspace:props.row.server.account})" @click.stop @auxclick.stop>{{props.row.server.account}}</a></q-td></template>
            <template #body-cell-account="props"><q-td :props="props"><button class="table-link" @click.stop="chooseAccount(props.value)">{{props.value}}</button></q-td></template>
            <template #body-cell-action="props"><q-td :props="props"><q-btn v-if="view==='servers' && props.row.type==='VPS'" flat round dense color="primary" icon="monitor_heart" :aria-label="`${t('Telemetry')} ${props.row.name || props.row.ip}`" :href="routeHash({view:'telemetry',server:props.row.id})" @click.stop><q-tooltip>{{t('Telemetry')}}</q-tooltip></q-btn><template v-if="canEdit && resource"><q-btn flat round dense icon="edit" :aria-label="`${t('Edit')} ${props.row.name || props.row.login}`" @click.stop="manage('edit',props.row)" /><q-btn flat round dense color="negative" icon="delete_outline" :aria-label="`${t('Delete')} ${props.row.name || props.row.login}`" @click.stop="manage('delete',props.row)" /></template><q-btn flat round dense icon="chevron_right" :aria-label="`${t('View details for')} ${props.row.name || props.row.login}`" @click.stop="openRow(props.row)"/></q-td></template>
            <template #no-data><div class="empty-state"><q-icon name="search_off" size="36px"/><h3>{{search?t('No results for this search'):t('No records in this selection')}}</h3><p>{{account?t('This workspace has no records in this view. You can select another workspace.'):t('Adjust the search or filters to find other records.')}}</p><q-btn v-if="search || account || serverScope || projectSelection.length || imageScope.length || coverage!=='all' || containerStatuses.length!==1 || containerStatuses[0]!=='running'" flat no-caps color="primary" :label="t('Clear all filters')" @click="clearFilters"/></div></template>
          </q-table>
        </q-card>
      </q-page>
    <q-dialog v-model="drawer" position="right" full-height class="server-detail-dialog"><div class="detail-panel" v-if="selected"><div class="detail-heading"><div><span>{{selected.type==='VPS'?t('Server details'):t('Service details')}}</span><h2>{{selected.name || selected.product}}</h2></div><div class="row no-wrap"><q-btn flat round icon="refresh" :aria-label="t('Refresh')" :loading="detailLoading" @click="loadDetails(true)" /><q-btn flat round icon="close" :aria-label="t('Close details')" v-close-popup/></div></div><div class="detail-meta"><div><small>{{t('Workspace')}}</small><button @click="chooseAccount(selected.account);drawer=false">{{selected.account}}</button></div><div><small>{{t('IP address')}}</small><button :disabled="!selected.ip || selected.type==='Backup'" @click="copy(selected.ip)">{{selected.type==='Backup' ? t('Not applicable') : selected.ip || t('Not applicable')}}<q-icon v-if="selected.ip && selected.type!=='Backup'" name="content_copy"/></button></div><div><small>{{t('Provider / product')}}</small><strong>{{selected.provider}} / {{selected.product}}</strong></div><div><small>{{t('Provider status')}}</small><span class="status-pill"><i></i>{{selected.status==='ACTIVE'?t('Active'):selected.status}}</span></div></div><q-btn v-if="selected.type==='VPS'" outline no-caps color="primary" icon="monitor_heart" :label="t('Telemetry')" :href="routeHash({view:'telemetry',server:selected.id})" class="q-mb-md q-mr-sm" @click="drawer=false"/><q-btn v-if="canEdit && selected.type==='VPS'" outline no-caps color="primary" icon="terminal" :label="t('Install daemon')" :href="`#/servers/${selected.id}/agent-installation`" class="q-mb-md" @click="drawer=false"/><div class="credential-box"><q-icon name="key" size="22px"/><div><strong>{{selected.credential?.item || t('Credential not mapped')}}</strong><small>{{selected.credential ? `1Password / ${selected.credential.vault}` : t('No confirmed reference in the inventory')}}</small></div><q-btn v-if="selected.credential" flat dense round icon="content_copy" :aria-label="t('Copy credential reference')" @click="copy(`op://${selected.credential.vault}/${selected.credential.item}`)"/></div><div v-if="selected.type==='VPS'" class="detail-project-heading"><h3>{{t('Projects')}} <span>{{selected.project_count ?? '—'}}</span></h3><p>{{t('Server directories and containers')}}</p></div><div v-if="selected.type!=='VPS'" class="detail-empty"><q-icon name="cloud_queue" size="32px"/><h3>{{selected.type}}</h3><p>{{t('Additional workspace service. No linked projects or containers in this inventory.')}}</p></div><div v-else-if="!hasInventory(selected)" class="detail-empty"><q-icon name="pending_actions" size="32px"/><h3>{{t('Internal inventory pending')}}</h3><p>{{t('Projects have not been confirmed. Access may require SSH, network connectivity or VPN.')}}</p></div><div v-else-if="!selected.project_count" class="detail-empty"><q-icon name="dns" size="32px"/><h3>{{t('No containers inventoried')}}</h3><p>{{t('The inventory completed without running containers accessible to the user.')}}</p></div><template v-else><q-input v-model="detailSearch" debounce="300" outlined dense clearable :placeholder="t('Filter projects or images')" :aria-label="t('Filter server projects')"><template #prepend><q-icon name="search"/></template></q-input><p v-if="!detailLoading && !detailProjects.length" class="detail-empty">{{t('No projects match the search.')}}</p><q-expansion-item v-for="project in detailProjects" :key="`${project.name}:${project.path}`" :label="project.name" :caption="project.path || t('Path not confirmed')" icon="folder_open" class="project-item" @show="loadProjectContainers(project)"><div class="container-item" v-for="container in (detailContainers[project.id]?.items || [])" :key="container.name"><q-icon name="layers" size="18px"/><div><strong>{{container.name}}</strong><code>{{container.image}}</code></div><q-btn flat dense round size="sm" icon="content_copy" :aria-label="`${t('Copy image')} ${container.image}`" @click="copy(container.image)"/></div><div v-if="detailContainers[project.id]?.totalPages>1" class="q-pa-md"><q-pagination :model-value="detailContainerPages[project.id] || 1" :max="detailContainers[project.id].totalPages" :max-pages="5" @update:model-value="page=>loadProjectContainers(project,page)" /></div></q-expansion-item><q-spinner v-if="detailLoading" color="primary" /><q-pagination v-if="detailTotal>10" v-model="detailPage" :max="Math.ceil(detailTotal/10)" :max-pages="5" /></template></div></q-dialog>
    <RecordDetailDialog v-if="containerDetails" v-model="containerDialog" :title="containerDetails.name" :subtitle="containerDetails.project" :fields="containerFields" :close-label="t('Close details')">
      <template #actions><q-btn flat no-caps color="primary" :label="t('Image usage')" @click="openImage(containerDetails.image)"/><q-btn flat no-caps color="primary" :label="t('Server details')" @click="selected=containerDetails.server;detailSearch='';containerDialog=false;drawer=true" /></template>
    </RecordDetailDialog>

  </MainLayout>
</template>
