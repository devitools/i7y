import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrganizationTransport } from '../apps/web/src/organization-context.js'
import { readRoute, routeHash } from '../apps/web/src/routes.js'
import { protectedRoute } from '../apps/web/src/auth-routing.js'

test('switching organizations rejects a pending response and sends the new context', async()=>{
  let org='first',resolve
  const transport=createOrganizationTransport(()=>org,()=>new Promise(done=>resolve=done))
  const first=transport.beforeSend('/api/records',{headers:{Accept:'application/json'}})
  assert.equal(first.options.headers['X-I7y-Organization'],'first')
  const pending=first.options.fetch('/api/records')
  org='second';transport.invalidate()
  resolve({})
  await assert.rejects(pending,/context changed/)
  const second=transport.beforeSend('/api/records',{headers:{}})
  assert.equal(second.options.headers['X-I7y-Organization'],'second')
})

test('switching while parsing a response body cannot publish the previous organization data',async()=>{
  const transport=createOrganizationTransport(()=>'first',async()=>({}))
  const request=transport.beforeSend('/api/records',{})
  const response=await request.options.fetch('/api/records')
  transport.invalidate()
  assert.throws(()=>transport.afterSend(response,{items:[{name:'private'}]}),/context changed/)
})

test('invitation routes survive authentication and organization management is reloadable',()=>{
  const hash='#/invite/i7yi_'+'a'.repeat(64)
  assert.equal(protectedRoute(hash,false).hash,hash)
  assert.equal(protectedRoute(hash,true).hash,hash)
  assert.equal(readRoute(hash).view,'invite')
  assert.equal(routeHash({view:'organizations'}),'#/organizations')
  assert.equal(readRoute('#/organizations').view,'organizations')
})

test('organization forms and member and invitation lists have independent reloadable routes',()=>{
  for(const action of ['new','edit','delete','transfer'])assert.deepEqual(readRoute('#/organizations/'+action),{view:'organizations',section:'organizations',action})
  assert.deepEqual(readRoute('#/organizations/members'),{view:'organizations',section:'members',action:'list',id:null})
  assert.deepEqual(readRoute('#/organizations/members/memberid/edit'),{view:'organizations',section:'members',action:'edit',id:'memberid'})
  assert.deepEqual(readRoute('#/organizations/invitations/new'),{view:'organizations',section:'invitations',action:'new',id:null})
  assert.deepEqual(readRoute('#/organizations/invitations/inviteid/revoke'),{view:'organizations',section:'invitations',action:'revoke',id:'inviteid'})
})
