import assert from 'node:assert/strict'
import PocketBase from 'pocketbase'
import { inventoryQuery } from '../apps/web/src/inventory-query.js'
const pb=new PocketBase(process.env.I7Y_TEST_URL)
await pb.collection('users').authWithPassword(process.env.I7Y_TEST_EMAIL,process.env.I7Y_TEST_PASSWORD)
const organizations=await pb.send('/api/i7y/organizations',{method:'GET'})
const organization=process.env.I7Y_TEST_ORGANIZATION || organizations.items[0].id
pb.beforeSend=(url,options)=>({url,options:{...options,headers:{...options.headers,'X-I7y-Organization':organization}}})
async function page(resource,values={}) {
  const q=inventoryQuery(pb,resource,values)
  const result=await pb.collection('i7y_'+resource).getList(q.page,q.perPage,q.options)
  return {...result,items:result.items.map(r=>typeof r.payload==='string'?JSON.parse(r.payload):r.payload)}
}
const baseline=await pb.collection('containers').getFullList({expand:'project.server.workspace'})
const first=await page('containers',{perPage:10})
const second=await page('containers',{page:2,perPage:10})
assert.equal(first.totalItems,baseline.length)
assert.equal(first.items.length,Math.min(10,baseline.length))
assert.ok(!first.items.some(a=>second.items.some(b=>a.id===b.id)))
const image=baseline[0].image
const matching=await page('containers',{image})
assert.equal(matching.totalItems,baseline.filter(c=>c.image===image).length)
const workspace=baseline[0].expand.project.expand.server.expand.workspace.login
const scoped=await page('containers',{workspace})
assert.equal(scoped.totalItems,baseline.filter(c=>c.expand.project.expand.server.expand.workspace.login===workspace).length)
const catalog=await page('images',{perPage:100})
assert.equal(catalog.totalItems,new Set(baseline.map(c=>c.image)).size)
const imageScoped=await page('images',{workspace,perPage:100})
assert.equal(imageScoped.items.reduce((n,r)=>n+r.count,0),scoped.totalItems)
for(const resource of ['workspaces','servers','projects']) {
  const result=await page(resource)
  assert.ok(result.items.length<=10)
  const row=result.items[0]
  const detail=await page(resource,{id:row.id,perPage:1})
  assert.equal(detail.totalItems,1)
  if(resource==='servers') assert.equal(row.container_count,baseline.filter(c=>c.expand.project.server===row.id).length)
  if(resource==='projects') assert.equal(row.container_count,baseline.filter(c=>c.project===row.id).length)
}
for(const [resource,sortBy] of [['workspaces','containers'],['servers','inventory'],['projects','containers'],['containers','image'],['images','containers']]) await page(resource,{sortBy,descending:true})
assert.equal((await page('containers',{search:'\' || id != "'})).totalItems,0)
console.log('PASS: pagination, image aggregates, scoped counts, sorting, relations and bound search')
