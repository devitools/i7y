import test from 'node:test'
import assert from 'node:assert/strict'
import PocketBase from 'pocketbase'
import { inventoryQuery } from '../apps/web/src/inventory-query.ts'
const client=new PocketBase('http://localhost')

test('pagination, sorting, scope and search are delegated to the API', () => {
  const query=inventoryQuery(client,'containers',{page:3,perPage:25,workspace:'team@example.com',server:'server',project:'project',image:'nginx:1.27',search:'a" || id != "',sortBy:'image',descending:true})
  assert.equal(query.page,3)
  assert.equal(query.perPage,25)
  assert.equal(query.options.sort,'-image,id')
  assert.match(query.options.filter,/workspace_login = 'team@example.com'/)
  assert.match(query.options.filter,/server_id = 'server'/)
  assert.match(query.options.filter,/project_id = 'project'/)
  assert.match(query.options.filter,/image = 'nginx:1.27'/)
  assert.ok(query.options.filter.includes(client.filter('search_text ~ {:value}',{value:'a" || id != "'})))
  assert.equal(query.options.fields,'id,payload')
})

test('global and scoped image catalogs never mix and page size stays bounded', () => {
  assert.equal(inventoryQuery(client,'images').options.filter,"workspace_login = ''")
  assert.equal(inventoryQuery(client,'images',{workspace:'team'}).options.filter,"workspace_login = 'team'")
  assert.equal(inventoryQuery(client,'servers',{perPage:1000}).perPage,100)
  assert.equal(inventoryQuery(client,'servers',{sortBy:'unsafe sql'}).options.sort,'type_order,name,id')
  assert.throws(()=>inventoryQuery(client,'users'),TypeError)
})

test('removed containers are excluded on the server before pagination unless explicitly requested',()=>{
 assert.match(inventoryQuery(client,'containers').options.filter,/state != 'missing'/)
 assert.match(inventoryQuery(client,'containers').options.filter,/state != 'removed'/)
 assert.doesNotMatch(inventoryQuery(client,'containers',{includeRemoved:true}).options.filter,/state/)
 assert.doesNotMatch(inventoryQuery(client,'containers',{id:'record'}).options.filter,/state/)
 assert.equal(inventoryQuery(client,'containers',{sortBy:'state'}).options.sort,'state,id')
})

test('containers default to server then project then name across pages',()=>{
 assert.equal(inventoryQuery(client,'containers').options.sort,'server_name,project_name,name,id')
 assert.equal(inventoryQuery(client,'containers',{sortBy:'project'}).options.sort,'project_name,name,id')
 assert.equal(inventoryQuery(client,'containers',{sortBy:'project',descending:true}).options.sort,'-project_name,name,id')
 assert.equal(inventoryQuery(client,'containers',{sortBy:'name'}).options.sort,'name,id')
 assert.equal(inventoryQuery(client,'containers',{sortBy:'server'}).options.sort,'server_name,project_name,name,id')
 assert.equal(inventoryQuery(client,'containers',{sortBy:'server',descending:true}).options.sort,'-server_name,project_name,name,id')
})


test('server type and review filters combine before pagination and keep VPS first',()=>{
 const query=inventoryQuery(client,'servers',{serverType:'VPS',coverage:'pending',page:2})
 assert.match(query.options.filter,/type = 'VPS'/)
 assert.match(query.options.filter,/inventory_known = false/)
 assert.equal(query.page,2)
 assert.equal(query.options.sort,'type_order,name,id')
 assert.equal(inventoryQuery(client,'servers',{sortBy:'name',descending:true}).options.sort,'type_order,-name,id')
 assert.match(inventoryQuery(client,'servers',{serverType:'other'}).options.filter,/type != 'VPS'/)
 assert.match(inventoryQuery(client,'servers',{serverType:'Backup'}).options.filter,/type = 'Backup'/)
})

test('multiple images match any selection within the other API filters', () => {
  const images=['nginx:1.27',"mysql:8' || id != '"]
  const query=inventoryQuery(client,'containers',{image:images,workspace:'team',page:2,perPage:25})
  const expression=images.map(image=>client.filter('image = {:image}',{image})).join(' || ')
  assert.ok(query.options.filter.includes('('+expression+')'))
  assert.ok(query.options.filter.includes("workspace_login = 'team'"))
  assert.ok(query.options.filter.includes("state != 'missing'"))
  assert.equal(query.page,2)
  assert.equal(query.perPage,25)
  assert.ok(!inventoryQuery(client,'containers',{image:[]}).options.filter.includes('image ='))
  const single=inventoryQuery(client,'containers',{image:['nginx:1.27','nginx:1.27']})
  assert.equal(single.options.filter.match(/image =/g).length,1)
})

test('container statuses combine before pagination and keep removed aliases',()=>{
 const filter=inventoryQuery(client,'containers',{statuses:['running','exited'],workspace:'team',page:3}).options.filter
 assert.match(filter,/\(state = 'running' \|\| state = 'exited'\)/)
 assert.match(filter,/workspace_login = 'team'/)
 assert.doesNotMatch(filter,/state !=/)
 assert.match(inventoryQuery(client,'containers',{statuses:['missing']}).options.filter,/state = 'missing' \|\| state = 'removed'/)
 assert.doesNotMatch(inventoryQuery(client,'containers',{statuses:[]}).options.filter,/state/)
 assert.doesNotMatch(inventoryQuery(client,'containers',{statuses:['running'],id:'record'}).options.filter,/state/)
 assert.match(inventoryQuery(client,'containers',{statuses:["running' || true"]}).options.filter,/id = ''/)
})

test('bulk review loads exactly the selected inventory records including removed ones',()=>{
 const query=inventoryQuery(client,'containers',{ids:['a','b'],statuses:[],perPage:100})
 assert.match(query.options.filter,/\(id = 'a' \|\| id = 'b'\)/)
 assert.doesNotMatch(query.options.filter,/state/)
 assert.equal(query.perPage,100)
 assert.match(inventoryQuery(client,'containers',{ids:[]}).options.filter,/id = ''/)
})

test('multiple projects match any selection within server and status constraints',()=>{
 const projects=['project-a',"project-b' || id != '"]
 const query=inventoryQuery(client,'containers',{project:projects,server:'server',statuses:['running'],page:2})
 const expression=projects.map(project=>client.filter('project_id = {:project}',{project})).join(' || ')
 assert.ok(query.options.filter.includes('('+expression+')'))
 assert.ok(query.options.filter.includes("server_id = 'server'"))
 assert.ok(query.options.filter.includes("state = 'running'"))
 assert.equal(query.page,2)
 assert.doesNotMatch(inventoryQuery(client,'containers',{project:[]}).options.filter,/project_id/)
})

test('operating system filtering is applied before server pagination',()=>{
 const query=inventoryQuery(client,'servers',{operatingSystem:'Windows Server 2019 Standard',page:2})
 assert.match(query.options.filter,/os_name = 'Windows Server 2019 Standard'/)
 assert.equal(query.page,2)
 assert.match(inventoryQuery(client,'servers',{operatingSystem:'unknown'}).options.filter,/os_name = ''/)
})
