import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { flatten, hasInventory, matches } from '../apps/web/src/inventory.ts'
const workspaces = [{login:'team@example.com',services:[{type:'VPS',ip:'192.0.2.10',name:'example',projects:[{name:'example',path:'/projects/example',containers:[{name:'example-web',image:'nginx:stable'},{name:'example-db',image:'mysql:5.7'}]}]}]}]
test('preserves workspace, server, project and container relationships', () => {
  const data = flatten(workspaces)
  const container = data.containers.find(c => c.name === 'example-web')
  assert.equal(container.server.account, 'team@example.com')
  assert.equal(container.server.ip, '192.0.2.10')
  assert.equal(container.path, '/projects/example')
  assert.equal(container.image, 'nginx:stable')
  assert.equal(data.services.length, workspaces.reduce((n,a)=>n+a.services.length,0))
  assert.equal(new Set(data.containers.map(c=>c.key)).size, data.containers.length)
})
test('distinguishes pending discovery from an empty container inventory', () => {
  assert.equal(hasInventory({projects:null}), false)
  assert.equal(hasInventory({projects:[]}), true)
  assert.equal(hasInventory({}), false)
})
test('searches images and IP addresses, including a cleared search field', () => {
  const data = flatten(workspaces)
  assert.ok(matches(data.servers.find(s=>s.ip==='192.0.2.10'), 'MYSQL:5.7'))
  assert.equal(matches({}, null), true)
  assert.equal(matches({ip:'192.0.2.10'}, 'inexistente'), false)
})

test('image usage finds exact versions across projects and workspaces', async () => {
  const { containersUsingImage } = await import('../apps/web/src/inventory.js')
  const containers = [{name:'a',image:'mysql:5.7',workspace:'one'},{name:'b',image:'mysql:5.7',workspace:'two'},{name:'c',image:'mysql:8.0',workspace:'one'}]
  assert.deepEqual(containersUsingImage(containers,'mysql:5.7').map(c=>c.name),['a','b'])
  assert.deepEqual(containersUsingImage(containers,'missing'),[])
})

test('image catalog groups exact versions and sorts by container count', async () => {
  const { groupImages } = await import('../apps/web/src/inventory.js')
  const rows = groupImages([{image:'mysql:5.7'},{image:'mysql:8.0'},{image:'mysql:5.7'}])
  assert.deepEqual(rows,[{key:'mysql:5.7',name:'mysql:5.7',count:2},{key:'mysql:8.0',name:'mysql:8.0',count:1}])
  assert.deepEqual(groupImages([]),[])
})
