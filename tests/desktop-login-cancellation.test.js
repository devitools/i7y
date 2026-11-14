import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}}
function harness(paused){
  const entered=deferred(),release=deferred(),calls=[],activeConnectionId={value:'a'}
  async function boundary(name){calls.push(name);if(paused===name){entered.resolve();await release.promise}}
  const invoke=async(command,args)=>{calls.push({command,args});await boundary('invoke')}
  const require=name=>{
    if(name==='@tauri-apps/api/core')return {invoke}
    if(name==='./api')return {prepareConnectionLogin:()=>boundary('prepare'),desktopAuthApi:{forConnection:id=>({available:()=>boundary('available'),exchange:async()=>{calls.push({exchange:id});return true}})}}
    if(name==='./desktop-backend')return {activeConnectionId,desktopRuntime:true}
    if(name==='./desktop-login-flow')return {waitForDesktopAuthorization:async options=>{calls.push('wait');await options.exchange()}}
    throw new Error(name)
  }
  const context={exports:{},require,TextEncoder,Uint8Array,DOMException,crypto:{getRandomValues:array=>array.fill(7),subtle:{digest:async()=>{await boundary('challenge');return new Uint8Array(32).buffer}}}}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/web/src/desktop-auth.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context)
  return {...context.exports,calls,entered:entered.promise,release:release.resolve,activeConnectionId}
}
for(const boundary of ['prepare','available','challenge'])test('leaving during '+boundary+' cannot open a late authorization browser',async()=>{
  const h=harness(boundary),controller=new AbortController()
  const pending=h.browserSignIn(controller.signal,()=>{})
  await h.entered;controller.abort();h.release()
  await assert.rejects(pending,error=>error.name==='AbortError')
  assert.equal(h.calls.some(call=>call?.command==='open_browser_login'),false)
  assert.equal(h.calls.includes('wait'),false)
})
test('an already cancelled login performs no preparation or native work',async()=>{
  const h=harness(),controller=new AbortController();controller.abort()
  await assert.rejects(h.browserSignIn(controller.signal,()=>{}),error=>error.name==='AbortError')
  assert.deepEqual(h.calls,[])
})
test('cancelling from the request callback is checked immediately before native open',async()=>{
  const h=harness(),controller=new AbortController()
  await assert.rejects(h.browserSignIn(controller.signal,()=>controller.abort()),error=>error.name==='AbortError')
  assert.equal(h.calls.some(call=>call?.command==='open_browser_login'),false)
})
test('an accepted login keeps its original profile when the sidebar changes while preparing',async()=>{
  const h=harness('prepare'),controller=new AbortController()
  const pending=h.browserSignIn(controller.signal,()=>{})
  await h.entered;h.activeConnectionId.value='b';h.release();await pending
  const opened=h.calls.find(call=>call?.command==='open_browser_login')
  assert.equal(opened.args.connectionId,'a')
  assert.equal(h.calls.find(call=>call?.exchange).exchange,'a')
})
test('cancelling while native open returns cannot begin token exchange',async()=>{
  const h=harness('invoke'),controller=new AbortController()
  const pending=h.browserSignIn(controller.signal,()=>{})
  await h.entered;controller.abort();h.release()
  await assert.rejects(pending,error=>error.name==='AbortError')
  assert.equal(h.calls.includes('wait'),false)
})
