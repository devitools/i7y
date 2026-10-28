import test from 'node:test'
import assert from 'node:assert/strict'
import { createManagementApi } from '../apps/web/src/management.ts'

test('management forwards CRUD and authentication through the same client', async () => {
  const calls = []
  const client = {
    collection: name => new Proxy({}, {get: (_, method) => (...args) => { calls.push([name, method, ...args]); return Promise.resolve({id:'record'}) }}),
    authStore: {clear: () => calls.push(['logout'])},
  }
  const api = createManagementApi(client)
  await api.signIn('operator@example.com', 'password')
  for (const resource of ['workspaces','servers','projects','containers']) {
    await api.create(resource, {name:'example'})
    await api.update(resource, 'record', {name:'updated'})
    await api.get(resource, 'record')
    await api.list(resource, {page:2, filter:'name = "example"'})
    await api.remove(resource, 'record')
  }
  await api.refreshSession()
  api.signOut()
  assert.deepEqual(calls[0], ['users','authWithPassword','operator@example.com','password'])
  assert.deepEqual(calls[4], ['workspaces','getList',2,50,{page:2,filter:'name = "example"'}])
  assert.deepEqual(calls.at(-2), ['users','authRefresh'])
  assert.deepEqual(calls.at(-1), ['logout'])
  assert.throws(() => api.remove('_superusers', 'record'), TypeError)
})
