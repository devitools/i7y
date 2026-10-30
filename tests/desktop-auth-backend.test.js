import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'

const base=process.env.I7Y_TEST_BACKEND_URL
const admin=process.env.I7Y_TEST_ADMIN_TOKEN
const hash=value=>createHash('sha256').update(value).digest('hex')
test('desktop authorization requires consent and proof, expires, and cannot be replayed', {skip:!base || !admin}, async()=>{
  const send=async(path,body,token=undefined,method='POST')=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:token}:{})},...(body?{body:JSON.stringify(body)}:{})})
    const data=await response.json().catch(()=>null)
    return {status:response.status,data}
  }
  const password=randomBytes(24).toString('hex')
  const created=await send('/api/collections/users/records',{email:`desktop-${randomBytes(5).toString('hex')}@example.com`,password,passwordConfirm:password},admin)
  assert.equal(created.status,200)
  try {
    const login=await send('/api/collections/users/auth-with-password',{identity:created.data.email,password})
    assert.equal(login.status,200)
    const token=login.data.token,request=randomBytes(32).toString('hex'),verifier=randomBytes(32).toString('hex')
    const authorization={request,challenge:hash(verifier)}
    assert.equal((await send('/api/i7y/desktop/authorize',authorization)).status,401)
    assert.equal((await send('/api/i7y/desktop/exchange',{request,verifier})).status,202)
    assert.equal((await send('/api/i7y/desktop/authorize',authorization,token)).status,204)
    assert.notEqual((await send('/api/i7y/desktop/authorize',authorization,token)).status,204)
    assert.equal((await send('/api/i7y/desktop/exchange',{request,verifier:'a'.repeat(64)})).status,400)
    const exchanged=await send('/api/i7y/desktop/exchange',{request,verifier})
    assert.equal(exchanged.status,200)
    assert.equal(exchanged.data.record.id,created.data.id)
    assert.ok(exchanged.data.token)
    assert.equal((await send('/api/i7y/desktop/exchange',{request,verifier})).status,400)
    const simultaneous=randomBytes(32).toString('hex')
    assert.equal((await send('/api/i7y/desktop/authorize',{request:simultaneous,challenge:hash(verifier)},token)).status,204)
    const raced=await Promise.all([send('/api/i7y/desktop/exchange',{request:simultaneous,verifier}),send('/api/i7y/desktop/exchange',{request:simultaneous,verifier})])
    assert.deepEqual(raced.map(r=>r.status).sort(),[200,400])
    const expired=randomBytes(32).toString('hex')
    await send('/api/collections/desktop_authorizations/records',{request_hash:hash(expired),challenge:hash(verifier),user:created.data.id,expires_at:new Date(Date.now()-10000).toISOString()},admin)
    assert.equal((await send('/api/i7y/desktop/exchange',{request:expired,verifier})).status,400)
    const attempts=await Promise.all([send('/api/i7y/desktop/exchange',{request:randomBytes(32).toString('hex'),verifier}),send('/api/i7y/desktop/authorize',{request:'invalid',challenge:'invalid'},token)])
    assert.deepEqual(attempts.map(r=>r.status),[202,400])
    assert.equal((await send('/api/collections/desktop_authorizations/records',null,token,'GET')).status,403)
  } finally {await send('/api/collections/users/records/'+created.data.id,null,admin,'DELETE')}
})
