import test from 'node:test'
import assert from 'node:assert/strict'
import {deleteContainers} from '../apps/web/src/bulk-delete.ts'
import {bulkDeleteHash,readRoute,routeHash} from '../apps/web/src/routes.ts'

test('bulk deletion tracks failures without retrying successful records',async()=>{
 const calls=[]
 const result=await deleteContainers(['a','b','a','c'],async id=>{
   calls.push(id)
   if(id==='b')throw {status:403}
   if(id==='c')throw {status:404}
 })
 assert.deepEqual(calls,['a','b','c'])
 assert.deepEqual(result.deleted,['a','c'])
 assert.deepEqual(result.failed.map(row=>row.id),['b'])
 const retry=[]
 await deleteContainers(result.failed.map(row=>row.id),async id=>retry.push(id))
 assert.deepEqual(retry,['b'])
})

test('bulk review has a reloadable route and preserves list filters',()=>{
 const ids=['a'.repeat(15),'b'.repeat(15)]
 const returnTo=routeHash({view:'containers',statuses:['missing'],image:['nginx','mysql'],page:3,sortBy:'server'})
 const review=readRoute(bulkDeleteHash([...ids,ids[0]],returnTo))
 assert.equal(review.view,'bulkDelete')
 assert.deepEqual(review.ids,ids)
 assert.equal(review.returnTo,returnTo)
 assert.deepEqual(readRoute(review.returnTo).statuses,['missing'])
 assert.deepEqual(readRoute('#/manage/containers/bulk-delete?id=invalid').ids,[])
})
