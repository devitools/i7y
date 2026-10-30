import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readRoute,routeHash} from '../apps/web/src/routes.ts'

test('alerts and incidents have separate menus while integrations stay under alerts',()=>{
  assert.equal(routeHash({view:'alerts'}),'#/alerts')
  assert.equal(routeHash({view:'incidents'}),'#/incidents')
  assert.deepEqual(readRoute('#/alerts/integrations'),{view:'alerts',action:'list',section:'integrations'})
  assert.deepEqual(readRoute('#/alerts/disk-capacity/edit'),{view:'alerts',action:'edit',section:'rules',key:'disk-capacity'})
  assert.deepEqual(readRoute('#/incidents/123456789012345'),{view:'incidents',action:'detail',id:'123456789012345'})
})
