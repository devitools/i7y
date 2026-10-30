import test from 'node:test'
import assert from 'node:assert/strict'
import { restoreSession, createSessionCompletion } from '../apps/web/src/session-lifecycle.ts'
import { waitForDesktopAuthorization } from '../apps/web/src/desktop-login-flow.ts'
import { createOrganizationTransport } from '../apps/web/src/organization-context.ts'

test('a delayed unauthorized response cannot invalidate a newer login',async()=>{
  for(const original of ['', 'previous-session']) {
    let token=original,resolve
    const transport=createOrganizationTransport(()=>null,()=>new Promise(done=>resolve=done),()=>token)
    const pending=transport.beforeSend('/api/private',{}).options.fetch('/api/private')
    token='new-session'
    resolve(new Response('{}',{status:401}))
    await assert.rejects(pending,/Authentication context changed/)
    assert.equal(token,'new-session')
  }
})

test('authentication changes while parsing an old response also reject stale data',async()=>{
  let token='previous-session'
  const transport=createOrganizationTransport(()=>null,async()=>new Response('{}',{status:401}),()=>token)
  const response=await transport.beforeSend('/api/private',{}).options.fetch('/api/private')
  token='new-session'
  assert.throws(()=>transport.afterSend(response,{}),/Authentication context changed/)
})

test('session restoration preserves valid credentials during transient failures',async()=>{
  for(const status of [0,408,429,500,503]) {
    const store={isValid:true,token:'current',record:{collectionName:'users'}}
    let signedOut=false
    assert.equal(await restoreSession({refreshSession:async()=>{throw {status}},signOut:()=>{signedOut=true}},store),true)
    assert.equal(signedOut,false)
  }
  for(const status of [400,401,403]) {
    const store={isValid:true,token:'current',record:{collectionName:'users'}}
    assert.equal(await restoreSession({refreshSession:async()=>{throw {status}},signOut:()=>store.isValid=false},store),false)
  }
})

test('a stale session refresh failure cannot sign out a replacement session',async()=>{
  const store={isValid:true,token:'old',record:{collectionName:'users'}}
  assert.equal(await restoreSession({refreshSession:async()=>{store.token='new';throw {status:401}},signOut:()=>assert.fail('New session must remain active')},store),true)
})

test('auth notification and login event complete the same navigation only once',async()=>{
  let count=0,resolve
  const complete=createSessionCompletion(async()=>{count++;await new Promise(done=>resolve=done)})
  const first=complete(),second=complete()
  assert.equal(first,second)
  await Promise.resolve()
  assert.equal(count,1)
  resolve()
  await first
  const third=complete()
  await Promise.resolve()
  assert.equal(count,2)
  resolve()
  await third
})

test('browser authorization tolerates temporary network and service failures',async()=>{
  let attempt=0,clock=0
  await waitForDesktopAuthorization({signal:new AbortController().signal,now:()=>clock,pause:async ms=>{clock+=ms},exchange:async()=>{
    attempt++
    if(attempt===1)throw {status:0}
    if(attempt===2)throw {status:503}
    return attempt===4
  }})
  assert.equal(attempt,4)
})

test('browser authorization stops on invalid proof, timeout or cancellation',async()=>{
  await assert.rejects(waitForDesktopAuthorization({signal:new AbortController().signal,exchange:async()=>{throw {status:400}}}),{status:400})
  let clock=0
  await assert.rejects(waitForDesktopAuthorization({signal:new AbortController().signal,exchange:async()=>false,timeout:10,interval:10,now:()=>clock,pause:async ms=>{clock+=ms}}),{code:'desktop_authorization_timeout'})
  const controller=new AbortController();controller.abort()
  await assert.rejects(waitForDesktopAuthorization({signal:controller.signal,exchange:async()=>assert.fail('Cancelled authorization must not poll')}),{name:'AbortError'})
})

test('a previous login completion never masks the next session after logout',async()=>{
  let token='first',count=0
  const pending=[]
  const complete=createSessionCompletion(async()=>{count++;await new Promise(resolve=>pending.push(resolve))},()=>token)
  const first=complete()
  await Promise.resolve()
  token='second'
  const second=complete()
  assert.notEqual(first,second)
  await Promise.resolve()
  assert.equal(count,2)
  pending[0]()
  await first
  assert.equal(complete(),second)
  pending[1]()
  await second
})
