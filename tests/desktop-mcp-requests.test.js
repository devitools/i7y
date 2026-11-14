import test from 'node:test'
import assert from 'node:assert/strict'
import {pendingRequests,requestLink,requestTab} from '../apps/web/src/mcp-requests.ts'
import {mcpPort,mcpConnectionJson} from '../apps/web/src/mcp-connection.ts'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {parse} from '@vue/compiler-sfc'
import {ref,computed,watch,effectScope} from 'vue'

function operationPage(t,toolCall){
  const {descriptor}=parse(readFileSync(new URL('../apps/web/src/components/DesktopMcpPage.vue',import.meta.url),'utf8'))
  const source=descriptor.scriptSetup.content.replace(/^import .*\n/gm,'')
  const scope=effectScope(),calls=[]
  const context={ref,computed,watch,onMounted:()=>{},onUnmounted:callback=>{context.unmount=callback},clearInterval:()=>{},nextTick:async()=>{},desktopRuntime:true,desktopBackend:ref('https://example.test/'),activeOrganization:ref('org-a'),requestTab,pendingRequests,mcpPort,mcpConnectionJson,copyToClipboard:async value=>{context.clipboard=value},t:value=>value,approvalError:String,window:{location:{hash:''},removeEventListener:()=>{}},pb:{},nativeContext:{backend:'https://example.test/',organization:'org-a',user:'user-a',generation:1}}
  context.invoke=async(name,args)=>{
    if(name==='mcp_overview')return {context:{...context.nativeContext},requests:[],connections:[],http:context.nativeHttp??context.page?.overview.value?.http}
    calls.push({name,...args})
    if(toolCall){const response=await toolCall(name,args);if(name==='mcp_http_configure')context.nativeHttp=response;return response}
    if(args.name==='plan_operation')return {plan:{operation_id:'plan-'+args.arguments.target,action:args.arguments.action.replaceAll('_','.'),target:args.arguments.target}}
    return {state:'approval_required',request_id:'request-a'}
  }
  const expose='\nglobalThis.page={action,target,operation,result,overview,canSubmit,preparedSelection,selectionKey,plan,submit,status,portDraft,portEdited,validPort,portChanged,portSaved,editPort,savePort,copyConnection,connectionPreview,refresh}'
  scope.run(()=>vm.runInNewContext(ts.transpileModule(source+expose,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context))
  t.after(()=>scope.stop())
  context.page.overview.value={context:{...context.nativeContext},requests:[],connections:[]}
  context.page.action.value='container_restart'
  context.page.target.value='target-a'
  return {...context.page,context,calls}
}

test('badge links to live pending requests instead of cancelled history',()=>{
  const requests=[{id:'cancelled',state:'cancelled',expires_at:600},{id:'expired',state:'approval_required',expires_at:100},{id:'second',state:'approval_required',expires_at:500},{id:'first',state:'approval_required',expires_at:400}]
  const pending=pendingRequests(requests,200)
  assert.deepEqual(pending.map(p=>p.id),['first','second'])
  const link=requestLink(pending[0].id)
  assert.equal(requestTab(link),'requests')
  assert.equal(new URLSearchParams(link.split('?')[1]).get('request'),'first')
  assert.equal(requests[0].id,'cancelled')
})
test('request tab remains correct for same-page links and invalid tab names',()=>{
  assert.equal(requestTab('#/desktop/mcp'),'requests')
  assert.equal(requestTab('#/desktop/mcp?tab=connections'),'connections')
  assert.equal(requestTab(requestLink('next')),'requests')
  assert.equal(requestTab('#/desktop/mcp?tab=unsupported'),'requests')
})

test('changing target invalidates the prepared operation and blocks stale submission',async t=>{
  const page=operationPage(t)
  await page.plan()
  assert.equal(page.canSubmit.value,true)
  page.target.value='target-b'
  assert.equal(page.operation.value,null)
  assert.equal(page.result.value,null)
  await page.submit()
  assert.equal(page.calls.some(call=>call.name==='submit_operation'),false)
  await page.plan()
  await page.submit()
  assert.equal(page.calls.at(-1).name,'submit_operation')
  assert.equal(page.calls.at(-1).arguments.operation_id,'plan-target-b')
})

test('action and authentication context changes invalidate prepared operations',async t=>{
  for(const change of [
    page=>{page.action.value='container_stop'},
    page=>{page.context.activeOrganization.value='org-b'},
    page=>{page.context.desktopBackend.value='https://other.test/'},
    page=>{page.overview.value.context={...page.overview.value.context,user:'user-b'}},
    page=>{page.overview.value.context={...page.overview.value.context,generation:2}},
  ]){
    const page=operationPage(t)
    await page.plan()
    change(page)
    assert.equal(page.operation.value,null)
    assert.equal(page.canSubmit.value,false)
    await page.submit()
    assert.equal(page.calls.some(call=>call.name==='submit_operation'),false)
  }
})

test('an earlier asynchronous plan cannot restore an invalidated selection',async t=>{
  let finish
  const response=new Promise(resolve=>{finish=resolve})
  const page=operationPage(t,()=>response)
  const pending=page.plan()
  page.target.value='target-b'
  page.target.value='target-a'
  finish({plan:{operation_id:'stale',action:'container.restart',target:'target-a'}})
  await pending
  assert.equal(page.operation.value,null)
  assert.equal(page.result.value,null)
  assert.equal(page.canSubmit.value,false)
})

test('submit checks the returned plan action and target before invoking native execution',async t=>{
  for(const plan of [
    {operation_id:'wrong-target',action:'container.restart',target:'target-b'},
    {operation_id:'wrong-action',action:'container.stop',target:'target-a'},
  ]){
    const page=operationPage(t,async()=>({plan}))
    await page.plan()
    assert.equal(page.canSubmit.value,false)
    await page.submit()
    assert.equal(page.calls.some(call=>call.name==='submit_operation'),false)
  }
})

test('status responses stay bound to the preparation, selection, and mounted page',async t=>{
  for(const [accepted,change] of [
    [true,()=>{}],
    [false,page=>{page.target.value='target-b'}],
    [false,page=>{page.context.activeOrganization.value='org-b'}],
    [false,page=>{page.target.value='target-b';page.target.value='target-a'}],
    [false,page=>{page.context.unmount()}],
  ]){
    let finish
    const response=new Promise(resolve=>{finish=resolve})
    const page=operationPage(t,async(_name,args)=>args.name==='get_operation'?response:{plan:{operation_id:'plan-target-a',action:'container.restart',target:'target-a'}})
    await page.plan()
    page.result.value=null
    const pending=page.status()
    change(page)
    finish({operation_id:'plan-target-a',state:'succeeded'})
    await pending
    assert.equal(page.calls.at(-1).name,'get_operation')
    assert.equal(page.calls.at(-1).arguments.operation_id,'plan-target-a')
    if(accepted)assert.equal(page.result.value?.state,'succeeded')
    else assert.equal(page.result.value,null)
  }
})


test('MCP connection settings preserve unsaved port input across overview polling',async t=>{
  const page=operationPage(t)
  page.overview.value.http={ready:true,port:47831,url:'http://127.0.0.1:47831/mcp',authorization:'Bearer private-fixture'}
  assert.equal(page.portDraft.value,47831)
  page.editPort('49001')
  page.overview.value={...page.overview.value,http:{...page.overview.value.http,port:47832}}
  assert.equal(page.portDraft.value,'49001')
  assert.equal(page.validPort.value,49001)
  assert.equal(page.portChanged.value,true)
})

test('MCP port save validates input and updates generated URL only after native success',async t=>{
  let fail=true
  const page=operationPage(t,async(name,args)=>{
    assert.equal(name,'mcp_http_configure')
    if(fail)throw 'Port unavailable'
    return {ready:true,port:args.port,url:'http://127.0.0.1:'+args.port+'/mcp',authorization:'Bearer private-fixture'}
  })
  page.overview.value.http={ready:true,port:47831,url:'http://127.0.0.1:47831/mcp',authorization:'Bearer private-fixture'}
  for(const value of ['',null,'0','1023','65536','1.2','4e4']){
    page.editPort(value)
    await page.savePort()
  }
  assert.equal(page.calls.length,0)
  page.editPort('49001')
  await page.savePort()
  assert.equal(page.overview.value.http.port,47831)
  assert.equal(page.portDraft.value,'49001')
  assert.equal(page.portSaved.value,false)
  fail=false
  await page.savePort()
  assert.equal(page.portDraft.value,49001)
  assert.equal(page.portEdited.value,false)
  assert.equal(page.portSaved.value,true)
  assert.equal(page.calls.at(-1).port,49001)
})

test('generic connection preview hides credentials while explicit copy retains client-neutral fields',async t=>{
  const page=operationPage(t)
  page.overview.value.http={ready:true,port:47831,url:'http://127.0.0.1:47831/mcp',authorization:'Bearer private-fixture'}
  assert.equal(page.connectionPreview.value.includes('private-fixture'),false)
  await page.copyConnection('config')
  const value=JSON.parse(page.context.clipboard)
  assert.equal(value.transport,'streamable_http')
  assert.equal(value.url,'http://127.0.0.1:47831/mcp')
  assert.equal(value.headers.Authorization,'Bearer private-fixture')
  assert.equal('mcp_servers' in value,false)
  assert.equal('mcpServers' in value,false)
})
