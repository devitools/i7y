import test from 'node:test'
import assert from 'node:assert/strict'
import { createQueryCache } from '../apps/web/src/query-cache.js'

test('cache coalesces requests, separates pages and expires after its TTL', async () => {
  let now=0,calls=0
  const cache=createQueryCache({ttl:30,now:()=>now})
  const fetcher=async()=>++calls
  assert.deepEqual(await Promise.all([cache.get('page1',fetcher),cache.get('page1',fetcher)]),[1,1])
  assert.equal(await cache.get('page2',fetcher),2)
  assert.equal(await cache.get('page1',fetcher),1)
  now=31
  assert.equal(await cache.get('page1',fetcher),3)
  assert.equal(await cache.get('page1',fetcher,{force:true}),4)
})

test('refresh replaces only its query and old requests cannot overwrite new results', async () => {
  const cache=createQueryCache()
  let resolveOld
  const old=cache.get('current',()=>new Promise(resolve=>resolveOld=resolve))
  await Promise.resolve()
  await cache.get('other',async()=>7)
  assert.equal(await cache.get('current',async()=>2,{force:true}),2)
  resolveOld(1)
  await old
  assert.equal(await cache.get('current',async()=>3),2)
  assert.equal(await cache.get('other',async()=>8),7)
})

test('errors are retried and clearing a session discards pending cached results', async () => {
  const cache=createQueryCache()
  await assert.rejects(cache.get('x',async()=>{throw new Error('offline')}))
  assert.equal(await cache.get('x',async()=>1),1)
  let resolveOld
  const pending=cache.get('private',()=>new Promise(resolve=>resolveOld=resolve))
  await Promise.resolve()
  cache.clear()
  resolveOld('old-user')
  await pending
  assert.equal(await cache.get('private',async()=>'new-user'),'new-user')
})

test('cache stays bounded while searching many distinct queries', async () => {
  const cache=createQueryCache({maxEntries:2})
  await cache.get('one',async()=>1)
  await cache.get('two',async()=>2)
  await cache.get('three',async()=>3)
  assert.equal(await cache.get('two',async()=>20),2)
  assert.equal(await cache.get('one',async()=>10),10)
})
