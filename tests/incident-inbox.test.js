import test from 'node:test'
import assert from 'node:assert/strict'
import { createIncidentInbox, createIncidentNotificationInbox, compareIncidents, incidentKey, incidentHref } from '../apps/web/src/incident-inbox.ts'
import { readRoute } from '../apps/web/src/routes.ts'

const row=(id,opened,organization='same-org')=>({id,opened_at:opened,created:opened,organization})
function source(id,rows,{legacy=false,error=0}={}) {
  const calls=[]
  return {id,name:id,generation:1,organizations:[{id:'same-org',name:'Organization '+id,role:'editor'}],calls,send:async(path,query,organization)=>{
    calls.push({path,query,organization})
    if(error)throw {status:error}
    if(legacy && path.endsWith('/inbox'))throw {status:404}
    const start=(query.page-1)*query.perPage
    return {items:rows.slice(start,start+query.perPage),totalItems:rows.length,totalPages:Math.ceil(rows.length/query.perPage)}
  }}
}
test('merged pagination fills a buffered k-way order across backend pages and identical organization IDs',async()=>{
  const make=(prefix,count,offset)=>Array.from({length:count},(_,index)=>row(prefix+String(index).padStart(4,'0'),String(10000-index*3-offset).padStart(5,'0')))
  const a=source('a',make('same',240,0)),b=source('b',make('same',180,1)),inbox=createIncidentInbox()
  const expected=[...a.organizations.flatMap(()=>make('same',240,0).map(item=>({...item,connection_id:'a'}))),...make('same',180,1).map(item=>({...item,connection_id:'b'}))].sort(compareIncidents)
  const pages=[]
  for(let page=1;page<=9;page++)pages.push(...(await inbox.list([a,b],{page,perPage:50})).items)
  assert.deepEqual(pages.map(incidentKey),expected.map(incidentKey))
  assert.equal(new Set(pages.map(incidentKey)).size,420)
  assert.equal(a.calls.length,3)
  assert.equal(b.calls.length,2)
  assert.equal(pages.find(item=>item.connection_id==='b').organization_name,'Organization b')
})
test('only a missing inbox falls back to authorized organizations and failed sources retain healthy results',async()=>{
  const legacy=source('legacy',[row('legacy','9')],{legacy:true})
  const denied=source('denied',[],{error:403})
  const offline=source('offline',[],{error:503})
  const result=await createIncidentInbox().list([legacy,denied,offline])
  assert.deepEqual(result.items.map(item=>item.id),['legacy'])
  assert.equal(legacy.calls[1].organization,'same-org')
  assert.ok(legacy.calls[1].path.endsWith('/incidents'))
  assert.equal(denied.calls.length,1)
  assert.equal(offline.calls.length,1)
  assert.deepEqual(result.failures.sort(),['denied','offline'])
})
test('organization filters scope backend queries and pagination before merging',async()=>{
  for(const legacy of [false,true]) {
    const ignored=source('other-backend',[row('wrong-source','9')])
    const selected=source('selected',[],{legacy})
    selected.organizations.push({id:'other-org',name:'Other organization',role:'editor'})
    selected.send=async(path,query,organization)=>{
      selected.calls.push({path,query,organization})
      if(legacy && path.endsWith('/inbox'))throw {status:404}
      assert.equal(query.connection,undefined)
      assert.equal(query.organization,'same-org')
      if(legacy)assert.equal(organization,'same-org')
      const items=Array.from({length:3},(_,i)=>row('selected-'+i,String(9-i)))
      return {items,totalItems:3,totalPages:1}
    }
    const inbox=createIncidentInbox()
    const query={connection:'selected',organization:'same-org',perPage:2}
    const page1=await inbox.list([ignored,selected],query)
    const page2=await inbox.list([ignored,selected],{...query,page:2})
    assert.deepEqual(page1.items.map(item=>item.id),['selected-0','selected-1'])
    assert.deepEqual(page2.items.map(item=>item.id),['selected-2'])
    assert.equal(page1.totalItems,3)
    assert.equal(ignored.calls.length,0)
    const denied=await inbox.list([ignored,selected],{connection:'selected',organization:'not-authorized'})
    assert.equal(denied.totalItems,0)
    assert.deepEqual(denied.items,[])
    assert.equal(selected.calls.length,legacy?2:1)
  }
})
test('composite incident routes preserve fixed connection and organization for identical IDs',()=>{
  const a={id:'incident',connection_id:'a',organization:'org'},b={...a,connection_id:'b'}
  assert.notEqual(incidentKey(a),incidentKey(b))
  assert.deepEqual(readRoute(incidentHref(b)),{view:'incidents',action:'detail',id:'incident',connection:'b',organization:'org'})
})
test('an invalidated pending source cannot publish its data into a new inbox session',async()=>{
  let release
  const a=source('a',[]),inbox=createIncidentInbox()
  a.send=()=>new Promise(resolve=>release=resolve)
  const pending=inbox.list([a])
  await new Promise(resolve=>setImmediate(resolve))
  inbox.reset()
  release({items:[row('secret','9')],totalItems:1,totalPages:1})
  await assert.rejects(pending,/context changed/)
  assert.equal((await inbox.list([source('b',[row('safe','8')])])).items[0].id,'safe')
})
test('notification cursors are source/session scoped, aggregate counts, and drain startup history without replay',async()=>{
  const requests=[]
  function notices(id,legacy=false){return {id,name:id,generation:1,organizations:[{id:'same-org',name:id}],send:async(path,query,organization)=>{
    requests.push({id,path,organization,cursor:query.cursor})
    if(legacy && path.includes('/inbox/'))throw {status:404}
    const cursor=Number(query.cursor)
    const count=cursor===0?100:cursor===100?1:cursor===101?1:0
    return {items:Array.from({length:count},(_,index)=>({sequence:cursor+index+1,incident_id:'same-id',organization:'same-org',kind:'opening',title:id})),cursor:String(cursor+count),open_count:id==='a'?2:3}
  }}}
  const a=notices('a'),b=notices('b',true),inbox=createIncidentNotificationInbox()
  const first=await inbox.poll([a,b]);assert.equal(first.open_count,5);assert.equal(first.items.length,0)
  assert.equal((await inbox.poll([a,b])).items.length,0)
  const next=await inbox.poll([a,b]);assert.equal(next.items.length,2)
  assert.equal(new Set(next.items.map(item=>item.notice_key)).size,2)
  assert.equal(next.items.find(item=>item.connection_id==='b').source_generation,1)
  assert.ok(requests.some(item=>item.id==='b' && item.organization==='same-org' && item.cursor==='101'))
  const remaining=await inbox.poll([b]);assert.equal(remaining.open_count,3)
  b.generation=2
  const relogin=await inbox.poll([b]);assert.equal(relogin.items.length,0)
  assert.equal(requests.at(-1).cursor,'0')
})
test('a failing notification backend preserves healthy counts without 403 fallback',async()=>{
  const inbox=createIncidentNotificationInbox()
  let failed=false
  const a={id:'a',name:'a',generation:1,organizations:[{id:'same-org',name:'a'}],send:async()=>{if(failed)throw {status:403};return {items:[],cursor:'10',open_count:4}}}
  const b={...a,id:'b',send:async()=>({items:[],cursor:'7',open_count:2})}
  assert.equal((await inbox.poll([a,b])).open_count,6)
  failed=true
  const result=await inbox.poll([a,b]);assert.equal(result.open_count,6);assert.deepEqual(result.failures,['a'])
})

test('overlapping notification polls replay an uncommitted A notice while old B is blocked',async()=>{
  const inbox=createIncidentNotificationInbox(),requests=[],delivered=[]
  let releaseB,readA
  const aRead=new Promise(resolve=>readA=resolve)
  const a={id:'a',name:'a',generation:1,organizations:[{id:'same-org',name:'a'}],send:async(_path,query)=>{
    requests.push(['a',query.cursor])
    if(query.cursor==='0')return {items:[],cursor:'10',open_count:1}
    if(query.cursor==='10'){readA();return {items:[{sequence:11,incident_id:'notice-a',organization:'same-org',kind:'opening',title:'A live'}],cursor:'11',open_count:1}}
    return {items:[],cursor:'11',open_count:1}
  }}
  let bRequests=0
  const b={...a,id:'b',send:async(_path,query)=>{
    requests.push(['b',query.cursor]);bRequests++
    if(bRequests===2)await new Promise(resolve=>releaseB=resolve)
    return {items:[],cursor:'10',open_count:1}
  }}
  await inbox.poll([a,b])
  const older=inbox.poll([a,b])
  const rejected=assert.rejects(older,/context changed/)
  await aRead
  const newer=inbox.poll([a,b])
  releaseB()
  const result=await newer
  delivered.push(...result.items)
  await rejected
  delivered.push(...(await inbox.poll([a,b])).items)
  assert.deepEqual(delivered.map(notice=>[notice.connection_id,notice.sequence]),[['a',11]])
  assert.deepEqual(requests.filter(([id])=>id==='a').map(([,cursor])=>cursor),['0','10','10','11'])
})

test('a discarded deferred notification result cannot consume a notice before display accepts it',async()=>{
  const inbox=createIncidentNotificationInbox()
  const a={id:'a',name:'a',generation:1,organizations:[{id:'same-org',name:'a'}],send:async(_path,query)=>query.cursor==='0'?{items:[],cursor:'10',open_count:1}:query.cursor==='10'?{items:[{sequence:11,incident_id:'notice-a',organization:'same-org',kind:'opening',title:'A live'}],cursor:'11',open_count:1}:{items:[],cursor:'11',open_count:1}}
  await inbox.poll([a])
  const discarded=await inbox.poll([a],{deferCommit:true})
  const accepted=await inbox.poll([a],{deferCommit:true})
  assert.equal(discarded.items[0].sequence,11)
  assert.equal(accepted.items[0].sequence,11)
  assert.throws(discarded.commit,/context changed/)
  accepted.commit()
  assert.equal((await inbox.poll([a])).items.length,0)
})
