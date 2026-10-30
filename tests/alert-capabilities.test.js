import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'

const context={module:{exports:{}}}
vm.runInNewContext(readFileSync(new URL('../apps/backend/hooks/lib/alert-capabilities.js',import.meta.url),'utf8'),context)
const access=context.module.exports
test('alert capabilities permit only the intended operation routes',()=>{
  const base='/api/i7y/alerts/v1'
  assert.equal(access.forRoute('PUT',base+'/rules/disk'),'alerts:write')
  assert.equal(access.forRoute('POST',base+'/rules/simulate'),'alerts:read')
  assert.equal(access.forRoute('POST',base+'/incidents'),'incidents:create')
  assert.equal(access.forRoute('POST',base+'/incidents/123456789012345/resolve'),'incidents:resolve')
  assert.equal(access.forRoute('GET',base+'/notification-events'),'incidents:read')
  for(const [method,path] of [['POST','/integrations'],['POST','/integrations/123456789012345/rotate'],['GET','/integrations'],['POST','/incidents/123456789012345/claim'],['PATCH','/incidents/123456789012345'],['PUT','/rules/disk/nested']])assert.equal(access.forRoute(method,base+path),'')
  assert.equal(access.forRoute('POST','/api/i7y/desktop/authorize'),'')
  assert.equal(access.forRoute('POST','/api/i7y/desktop/exchange'),'')
})
test('legacy and invalid token capability data grant no alert access',()=>{
  for(const value of ['',null,'{}','["*:"]','["alerts:read", "unknown"]'])assert.equal(access.capabilities({getString:()=>value}).length,0)
  assert.deepEqual([...access.normalize(['alerts:read','alerts:read'])],['alerts:read'])
  assert.throws(()=>access.normalize('alerts:read'))
  assert.throws(()=>access.normalize(['incidents:claim']))
})
