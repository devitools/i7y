import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import ts from 'typescript'
import PocketBase, {BaseAuthStore} from 'pocketbase'
import * as vue from 'vue'
import { createOrganizationTransport } from '../apps/web/src/organization-context.ts'
import { restoreSession } from '../apps/web/src/session-lifecycle.ts'

const marker='native.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+86400})).toString('base64url')+'.session'
function harness() {
  const profiles=[{id:'a',name:'A',url:'https://a.test/'}]
  const nativeSessions=new Map([['a',{token:'secret-a',record:{id:'identical-user',collectionName:'users',email:'a@test'}}]])
  let selected='a',blocked
  const storage=new Map(),calls=[],restoreErrors=new Map()
  const invoke=async(command,args={})=>{
    calls.push({command,args})
    if(command==='get_connections')return {items:profiles.map(profile=>({...profile})),selected}
    if(command==='add_connection'){let connection=profiles.find(profile=>profile.url===args.backendUrl);if(!connection){connection={id:'b',name:args.name || 'B',url:args.backendUrl};profiles.push(connection)}return {...connection}}
    if(command==='select_connection'){selected=args.connectionId;return}
    if(command==='rename_connection'){profiles.find(profile=>profile.id===args.connectionId).name=args.name;return}
    if(command==='desktop_session_context')return
    if(command==='desktop_connection_logout'){nativeSessions.delete(args.connectionId);return}
    if(command==='remove_connection'){nativeSessions.delete(args.connectionId);profiles.splice(profiles.findIndex(profile=>profile.id===args.connectionId),1);if(selected===args.connectionId)selected=profiles[0]?.id || '';return}
    if(command==='desktop_session_restore'){if(restoreErrors.has(args.connectionId))throw restoreErrors.get(args.connectionId);const session=nativeSessions.get(args.connectionId);return session?{token:marker,record:session.record}:null}
    if(command==='backend_request'){
      const profile=profiles.find(profile=>profile.id===args.connectionId)
      assert.equal(new URL(args.url).origin,new URL(profile.url).origin)
      if(blocked){const wait=blocked;blocked=null;await wait}
      let result
      if(args.url.includes('/desktop/exchange')){nativeSessions.set(args.connectionId,{token:'secret-'+args.connectionId,record:{id:'identical-user',collectionName:'users',email:args.connectionId+'@test'}});result={token:marker,record:nativeSessions.get(args.connectionId).record}}
      else if(args.url.includes('/organizations'))result={items:[{id:'same-org',name:profile.name+' org',role:'admin'}],global_admin:false}
      else result={id:'incident',items:[],connection:args.connectionId,organization:args.headers['x-i7y-organization']}
      return {status:200,content_type:'application/json',body:JSON.stringify(result)}
    }
    throw new Error(command)
  }
  const loaded=new Map(),root=path.resolve('apps/web/src')
  function load(name){
    const filename=path.join(root,name.replace(/\.ts$/,'')+'.ts')
    if(loaded.has(filename))return loaded.get(filename).exports
    const module={exports:{}};loaded.set(filename,module)
    const source=fs.readFileSync(filename,'utf8').replaceAll('import.meta.env.VITE_POCKETBASE_URL',"'/'")
    const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText
    const require=specifier=>{
      if(specifier==='pocketbase')return {__esModule:true,default:PocketBase,BaseAuthStore}
      if(specifier==='vue')return vue
      if(specifier==='@tauri-apps/api/core')return {invoke,isTauri:()=>true}
      if(specifier.startsWith('.'))return load(path.relative(root,path.resolve(path.dirname(filename),specifier)))
      throw new Error(specifier)
    }
    vm.runInNewContext(code,{module,exports:module.exports,require,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},window:{location:{origin:'https://ui.test'}},Response,Request,Headers,AbortController,DOMException,URL,URLSearchParams,fetch,setTimeout,clearTimeout,console},{filename})
    return module.exports
  }
  return {api:load('api'),clients:load('connection-clients'),nativeSessions,calls,restoreErrors,block:()=>{let release;blocked=new Promise(resolve=>release=resolve);return release}}
}
test('startup during a selected backend outage preserves native credentials and automatically restores only that source after recovery',async()=>{
  for(const failure of [{status:503},new Error('Unable to validate session')]){
    const h=harness()
    await h.api.addConnection('https://b.test/','B')
    await h.api.desktopAuthApi.forConnection('b').exchange('proof','verifier')
    h.restoreErrors.set('a',failure)
    await h.api.initializeDesktopBackend()
    assert.equal(h.api.authStore.isValid,false)
    assert.equal(h.clients.connectionClient('a').unavailable,true)
    assert.deepEqual(Array.from(h.api.connectedSources(),source=>source.id),['b'])
    assert.equal(await restoreSession(h.api.management,h.api.authStore),false)
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(h.calls.some(call=>call.command==='desktop_connection_logout'),false)
    assert.equal(h.nativeSessions.get('a').token,'secret-a')
    assert.equal(h.nativeSessions.get('b').token,'secret-b')
    assert.equal(h.clients.connectionClient('a').unavailable,true)
    const changes=[]
    const unsubscribe=h.api.authStore.onChange((token,record)=>{if(token)changes.push(record.email)})
    h.restoreErrors.delete('a')
    await h.api.refreshConnectedOrganizations()
    unsubscribe()
    assert.equal(h.api.authStore.isValid,true)
    assert.equal(h.api.authStore.record.email,'a@test')
    assert.deepEqual(changes,['a@test'])
    assert.equal(h.clients.connectionClient('a').unavailable,false)
    assert.deepEqual(Array.from(h.api.connectedSources(),source=>source.id).sort(),['a','b'])
    assert.equal(h.nativeSessions.get('b').token,'secret-b')
    assert.equal(h.api.activeConnectionId.value,'a')
    assert.equal(h.calls.some(call=>call.command==='desktop_connection_logout'),false)
  }
})
test('adding and logging into B preserves A; source-fixed mutations and logout affect only their profile',async()=>{
  const {api,nativeSessions,calls}=harness()
  await api.initializeDesktopBackend()
  await api.loadOrganizations()
  const a=api.incidentSourceClient('a','same-org')
  await api.addConnection('https://b.test/','B')
  await api.desktopAuthApi.forConnection('b').exchange('proof','verifier')
  await api.refreshConnectedOrganizations()
  assert.equal(nativeSessions.get('a').token,'secret-a')
  assert.equal(api.connectedSources().length,2)
  await api.selectConnection('b')
  assert.equal((await a.send('/api/i7y/alerts/v1/incidents/incident/resolve',{method:'POST',body:{version:3}})).connection,'a')
  const request=calls.filter(call=>call.command==='backend_request').at(-1).args
  assert.equal(request.connectionId,'a')
  assert.equal(new URL(request.url).origin,'https://a.test')
  assert.equal(request.headers['x-i7y-organization'],'same-org')
  assert.ok(calls.every(call=>!JSON.stringify(call.args).includes('secret-a')))
  await api.logoutConnection('a')
  assert.equal(nativeSessions.has('a'),false)
  assert.equal(nativeSessions.get('b').token,'secret-b')
  assert.deepEqual(Array.from(api.connectedSources(),source=>source.id),['b'])
  await api.removeConnection('a')
  assert.equal(nativeSessions.get('b').token,'secret-b')
})
test('a late response and captured action reject after that profile logs out while B stays authenticated',async()=>{
  const h=harness();await h.api.initializeDesktopBackend();await h.api.loadOrganizations()
  await h.api.addConnection('https://b.test/','B');await h.api.desktopAuthApi.forConnection('b').exchange('proof','verifier')
  const fixed=h.api.incidentSourceClient('a','same-org'),release=h.block()
  const pending=fixed.send('/api/i7y/alerts/v1/incidents/incident')
  await new Promise(resolve=>setImmediate(resolve))
  await h.api.logoutConnection('a');release()
  await assert.rejects(pending,error=>/changed/.test(String(error.originalError || error)))
  await assert.rejects(fixed.send('/api/i7y/alerts/v1/incidents/incident/resolve',{method:'POST'}),/changed/)
  assert.ok(h.nativeSessions.has('b'))
})
test('selected organization transport captures its original connection before delayed dispatch',async()=>{
  let selected='a'
  const calls=[]
  const transport=createOrganizationTransport(()=> 'org',undefined,()=> 'marker',()=>{const source=selected;return async()=>{calls.push(source);return new Response('{}')}})
  const request=transport.beforeSend('https://a.test/api/records',{})
  selected='b'
  await request.options.fetch('https://a.test/api/records')
  assert.deepEqual(calls,['a'])
})
