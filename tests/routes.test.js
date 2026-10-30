import test from 'node:test'
import assert from 'node:assert/strict'
import { routeHash, readRoute } from '../apps/web/src/routes.ts'

test('server ping has its own route and preserves a safe inventory return URL',()=>{
  const back='#/servers?workspace=team%40example.com&page=3&sortBy=name'
  assert.deepEqual(readRoute('#/servers/server01/actions/ping?returnTo='+encodeURIComponent(back)),{view:'serverPing',server:'server01',returnTo:back})
  assert.equal(readRoute('#/servers/server01/actions/ping?returnTo='+encodeURIComponent('https://example.com')).returnTo,null)
})

test('nested inventory links preserve workspace, server and project identities', () => {
  const route = {view:'containers',workspace:'team@example.com',server:'team@example.com:192.0.2.10:5',project:'project / a?b&c#1'}
  assert.deepEqual(readRoute(routeHash(route)),route)
})

test('global screens and unknown routes resolve predictably', () => {
  for (const view of ['accounts','servers','projects','containers']) assert.equal(readRoute(routeHash({view})).view,view)
  assert.equal(readRoute('').view,'accounts')
  assert.equal(readRoute('#/unknown').view,'accounts')
})

test('image usage links preserve image tags, digests and registry ports', () => {
  for (const image of ['webdevops/php-nginx:7.0','registry.internal:5000/app@sha256:abc123']) {
    const route = readRoute(routeHash({view:'images',image}))
    assert.equal(route.view,'images')
    assert.equal(route.image,image)
    assert.equal(route.workspace,null)
  }
})

test('image catalog and usage have distinct reloadable routes', () => {
  assert.equal(routeHash({view:'imageCatalog'}),'#/images')
  assert.equal(readRoute('#/images').view,'imageCatalog')
  assert.equal(readRoute(routeHash({view:'images',image:'mysql:5.7'})).view,'images')
  assert.equal(readRoute(routeHash({view:'imageCatalog',workspace:'team@example.com'})).workspace,'team@example.com')
})

test('management routes support direct links, reloads and scoped creation', async () => {
  const { managementHash } = await import('../apps/web/src/routes.js')
  for (const resource of ['workspaces','servers','projects','containers']) {
    assert.deepEqual(readRoute(managementHash(resource,'new',null,'parent-id')), {view:'manage',resource,action:'new',id:null,parent:'parent-id'})
    for (const action of ['edit','delete']) assert.deepEqual(readRoute(managementHash(resource,action,'record-id')), {view:'manage',resource,action,id:'record-id',parent:null})
  }
  assert.deepEqual(readRoute('#/login'), {view:'login'})
  assert.equal(readRoute('#/manage/operators/new').view,'accounts')
  assert.throws(()=>managementHash('operators'),TypeError)
})

test('API token pages have reloadable routes', () => {
  assert.deepEqual(readRoute('#/tokens'),{view:'tokens',action:'list'})
  assert.deepEqual(readRoute('#/tokens/new'),{view:'tokens',action:'new'})
  assert.deepEqual(readRoute('#/tokens/token-id/revoke'),{view:'tokens',action:'revoke',id:'token-id'})
  assert.equal(readRoute('#/tokens/token-id/unknown').view,'accounts')
})

test('list state survives management navigation and reloads', async () => {
  const {managementHash}=await import('../apps/web/src/routes.js')
  const state={view:'containers',workspace:'team@example.com',server:'server-id',project:'project-id',search:'app & db',includeRemoved:true,onlyWithServers:false,page:4,perPage:25,sortBy:'project',descending:true}
  const hash=routeHash(state)
  assert.deepEqual(readRoute(hash),state)
  for(const action of ['edit','delete']) {
    const route=readRoute(managementHash('containers',action,'container-id',null,hash))
    assert.equal(route.returnTo,hash)
    assert.deepEqual(readRoute(route.returnTo),state)
  }
})

test('server filters survive URLs and invalid return targets are ignored', async () => {
  const {managementHash,inventoryReturn}=await import('../apps/web/src/routes.js')
  const route=readRoute(routeHash({view:'servers',serverType:'VPS',coverage:'pending',page:2}))
  assert.equal(route.serverType,'VPS')
  assert.equal(route.coverage,'pending')
  assert.equal(route.page,2)
  for(const target of ['https://example.com','#/manage/containers/a/delete','#/login','#/servers/invalid']) {
    assert.equal(inventoryReturn(target),null)
    assert.equal(readRoute(managementHash('servers','delete','a',null,target)).returnTo,undefined)
  }
  const invalid=readRoute('#/servers?page=-1&perPage=NaN&descending=bad&coverage=bad')
  assert.equal(invalid.page,undefined)
  assert.equal(invalid.coverage,undefined)
})

test('multiple image selections survive URLs and management return links', async () => {
  const {managementHash}=await import('../apps/web/src/routes.js')
  const images=['registry.internal:5000/app@sha256:abc123','webdevops/php-nginx:8.3']
  const hash=routeHash({view:'containers',image:images,includeRemoved:true,page:2})
  assert.deepEqual(readRoute(hash).image,images)
  assert.equal(new URLSearchParams(hash.split('?')[1]).getAll('image').length,2)
  const management=readRoute(managementHash('containers','delete','record',null,hash))
  assert.deepEqual(readRoute(management.returnTo).image,images)
  assert.equal(readRoute(routeHash({view:'containers',image:[]})).image,undefined)
  assert.equal(readRoute(routeHash({view:'images',image:[images[0]]})).image,images[0])
})

test('old container URLs migrate the previous project default without losing filters', () => {
  const route=readRoute('#/containers?image=nginx&image=mysql&workspace=team&page=2&perPage=25&sortBy=project&descending=true')
  assert.equal(route.sortBy,'server')
  assert.equal(route.descending,false)
  assert.deepEqual(route.image,['nginx','mysql'])
  assert.equal(route.page,2)
  assert.equal(route.perPage,25)
  assert.equal(route.workspace,'team')
  const explicit=readRoute(routeHash({view:'containers',sortBy:'project',descending:true}))
  assert.equal(explicit.sortBy,'project')
  assert.equal(explicit.descending,true)
  assert.equal(readRoute('#/containers?sortBy=name').sortBy,'name')
})

test('container status selections survive reloads including all statuses',()=>{
 const route=readRoute(routeHash({view:'containers',statuses:['running','exited','missing'],server:'server',page:3}))
 assert.deepEqual(route.statuses,['running','exited','missing'])
 assert.equal(route.server,'server')
 assert.equal(route.page,3)
 assert.deepEqual(readRoute(routeHash({view:'containers',statuses:[]})).statuses,[])
 assert.deepEqual(readRoute('#/containers?status=invalid').statuses,['running'])
 assert.equal(readRoute('#/containers').statuses,undefined)
})

test('multiple projects survive reloads and management return links',async()=>{
 const {managementHash}=await import('../apps/web/src/routes.js')
 const projects=['project-a','project-b']
 const hash=routeHash({view:'containers',server:'server',project:projects,statuses:['running']})
 assert.deepEqual(readRoute(hash).project,projects)
 assert.equal(new URLSearchParams(hash.split('?')[1]).getAll('project').length,2)
 const edit=readRoute(managementHash('containers','edit','record',null,hash))
 assert.deepEqual(readRoute(edit.returnTo).project,projects)
 assert.equal(readRoute(routeHash({view:'containers',project:[]})).project,null)
 assert.equal(readRoute(routeHash({view:'containers',project:['project-a']})).project,'project-a')
})

test('empty list filters never become null strings and old URLs recover',()=>{
 const hash=routeHash({view:'servers',search:null,operatingSystem:null,serverType:'VPS',descending:false,page:1})
 assert.ok(!hash.includes('null'))
 assert.ok(hash.includes('descending=false'))
 const route=readRoute('#/servers?operatingSystem=null&search=null&serverType=VPS')
 assert.equal(route.search,undefined)
 assert.equal(route.operatingSystem,undefined)
 assert.equal(route.serverType,'VPS')
 const selected=readRoute(routeHash({view:'servers',search:'Windows',operatingSystem:'Windows Server 2019 Standard'}))
 assert.equal(selected.search,'Windows')
 assert.equal(selected.operatingSystem,'Windows Server 2019 Standard')
})

 test('organization links retain their target independently of active organization', () => {
  const organization='123456789abcdef'
  for(const action of ['edit','delete','transfer']) assert.deepEqual(readRoute(`#/organizations/${organization}/${action}`),{view:'organizations',section:'organizations',action,organization})
  assert.deepEqual(readRoute(`#/organizations/${organization}/members/abcdef123456789/edit`),{view:'organizations',section:'members',action:'edit',id:'abcdef123456789',organization})
  assert.equal(readRoute(`#/organizations/${organization}/invitations/new`).organization,organization)
})
