import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function apiHarness(){
  const calls=[],activeConnectionId={value:'a'},activeOrganization={value:'same-org'}
  const source=id=>({id,url:'https://'+id+'.test/',generation:1,client:{authStore:{token:'same-marker',record:{id:'same-user'}}},organizations:[{id:'same-org'}]})
  const sources=[source('a'),source('b')],authStore={isValid:true,token:'same-marker',record:{id:'same-user'}},pb={baseURL:'https://a.test/'}
  const api={activeConnectionId,activeOrganization,authStore,pb,connectedSources:()=>sources,incidentSourceClient:(id,org)=>({send:async(path,options)=>{calls.push({id,org,path,options});return {id:'record'}}})}
  const context={exports:{},URL,window:{location:{origin:'https://ui.test'}},require:name=>name==='./api'?api:{desktopRuntime:true}}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/web/src/server-power-api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context)
  return {...context.exports,api,sources,calls}
}
test('a source fixed power client rejects same-ID backend changes before reading or mutating',async()=>{
  const h=apiHarness(),source=h.captureServerPowerSource(),client=h.createServerPowerApi(source)
  await client.get('same-server')
  h.api.activeConnectionId.value='b'
  assert.throws(h.captureServerPowerSource,/context_changed/)
  h.api.pb.baseURL='https://b.test/'
  for(const action of [()=>client.get('same-server'),()=>client.save('same-server',{version:1}),()=>client.reconcile('same-server','same-job')])await assert.rejects(action(),/context_changed/)
  assert.equal(h.calls.length,1)
  assert.equal(h.calls[0].id,'a')
})
test('a captured power source rejects another login of the same user and unchanged marker',async()=>{
  const h=apiHarness(),source=h.captureServerPowerSource(),client=h.createServerPowerApi(source)
  h.sources[0].generation++
  await assert.rejects(client.save('same-server',{version:1}),/context_changed/)
  assert.equal(h.calls.length,0)
})
test('power progress requires exact connection session MCP generation user organization and lock epoch',()=>{
  const h=apiHarness(),expected={connectionId:'a',connectionGeneration:4,lockEpoch:7,context:{backend:'https://a.test/',user:'same-user',organization:'same-org',generation:8}}
  const event={server_id:'same-server',request_id:'same-request',context:expected}
  assert.equal(h.powerProgressMatches(expected,'same-server','same-request',event),true)
  for(const mutate of [value=>value.connectionId='b',value=>value.connectionGeneration++,value=>value.lockEpoch++,value=>value.context.backend='https://b.test/',value=>value.context.user='another-user',value=>value.context.organization='another-org',value=>value.context.generation++]){
    const changed=structuredClone(expected);mutate(changed)
    assert.equal(h.powerProgressMatches(expected,'same-server','same-request',{...event,context:changed}),false)
  }
})
function componentHarness(){
  const text=fs.readFileSync('apps/web/src/components/ServerPower.vue','utf8').match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1]
  const ast=ts.createSourceFile('power.ts',text,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS)
  const functions=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&['execution','execute','confirm','importConfiguration'].includes(node.name?.text)).map(node=>node.getText(ast)).join('\n')
  let confirmation,valid=true
  const native={connectionId:'a',connectionGeneration:1,lockEpoch:1,context:{backend:'https://a.test/',user:'same-user',organization:'same-org',generation:2}}
  const selected={identity:{organization:'same-org'},current:()=>valid}
  const calls=[],context={desktopRuntime:true,source:{value:selected},loaded:{value:{server:'same-server',source:JSON.stringify(selected.identity)}},local:{value:{context:native}},data:{value:{profile:{version:7},configuration_current:true,can_edit:true,can_configure:true,name:'A server',address:'1.2.3.4'}},props:{serverId:'same-server'},identity:{value:'/a-key'},viaHost:{value:true},opAccount:{value:'account-a'},generation:1,busy:{value:false},saving:{value:false},blocked:{value:false},error:{value:''},stage:{value:''},request:{value:''},crypto:{randomUUID:()=> 'request'},localStorage:{setItem:()=>{}},t:key=>key,showSettings:{value:true},q:{notify:()=>{},dialog:()=>({hide(){},onOk(callback){confirmation=callback;return this}})},invoke:async(command,args)=>{calls.push({command,args})},refresh:async()=>{},failure:()=> 'failed'}
  vm.createContext(context);vm.runInContext(ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context)
  return {context,calls,hasConfirmation:()=>!!confirmation,confirm:()=>confirmation(),invalidate:()=>valid=false}
}
test('confirmation retains native origin version and identity and rejects session changes even before the watcher runs',async()=>{
  const h=componentHarness();h.context.confirm('shutdown')
  h.context.data.value.profile.version=8;h.context.identity.value='/b-key';h.context.local.value.context.connectionId='b'
  await h.confirm();await new Promise(resolve=>setImmediate(resolve))
  assert.equal(h.calls[0].args.expectedContext.connectionId,'a')
  assert.equal(h.calls[0].args.version,7)
  assert.equal(h.calls[0].args.identityFile,'/a-key')
  const stale=componentHarness();stale.context.confirm('start');stale.invalidate();await stale.confirm()
  assert.equal(stale.calls.length,0)
})

test('a server prop or displayed source change rejects confirmation before the reset watcher runs',async()=>{
  const server=componentHarness();server.context.confirm('shutdown');server.context.props.serverId='other-server';await server.confirm();assert.equal(server.calls.length,0)
  const source=componentHarness();source.context.source.value.identity.organization='other-org';source.context.confirm('start');assert.equal(source.hasConfirmation(),false);assert.equal(source.calls.length,0)
})

test('vault import uses the captured native context and ignores completion after a source change',async()=>{
  const h=componentHarness(),notifications=[]
  let complete
  h.context.q.notify=value=>notifications.push(value)
  h.context.invoke=async(command,args)=>{h.calls.push({command,args});await new Promise(resolve=>complete=resolve)}
  const importing=h.context.importConfiguration()
  assert.equal(h.calls[0].command,'server_power_import_configuration')
  assert.equal(h.calls[0].args.serverId,'same-server')
  assert.equal(h.calls[0].args.expectedContext.connectionId,'a')
  h.invalidate();complete();await importing
  assert.equal(notifications.length,0)
  assert.equal(h.context.showSettings.value,true)
})
test('vault import is unavailable to readers editors and blocked operations',async()=>{
  for(const change of [h=>h.context.data.value.can_configure=false,h=>h.context.blocked.value=true,h=>h.context.local.value.context=undefined]){
    const h=componentHarness();change(h);await h.context.importConfiguration();assert.equal(h.calls.length,0)
  }
})

test('vault import rechecks its origin after refreshing the saved profile',async()=>{
  const h=componentHarness(),notifications=[]
  h.context.q.notify=value=>notifications.push(value)
  h.context.refresh=async()=>{h.invalidate();return true}
  await h.context.importConfiguration()
  assert.equal(notifications.length,0)
  assert.equal(h.context.showSettings.value,true)
})
