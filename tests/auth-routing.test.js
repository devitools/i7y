import test from 'node:test'
import assert from 'node:assert/strict'
import { protectedRoute } from '../apps/web/src/auth-routing.js'

test('only the login route is available without a session', () => {
  for (const hash of ['#/workspaces','#/servers','#/projects','#/containers','#/images','#/tokens','#/tokens/new','#/manage/workspaces/new','#/manage/projects/id/edit','#/unknown']) {
    assert.deepEqual(protectedRoute(hash,false),{hash:'#/login',returnTo:hash})
    assert.deepEqual(protectedRoute(hash,true),{hash})
  }
  assert.deepEqual(protectedRoute('#/login',false),{hash:'#/login'})
  assert.deepEqual(protectedRoute('#/login',true),{hash:'#/workspaces'})
  assert.deepEqual(protectedRoute('https://example.com',true),{hash:'#/workspaces'})
})
