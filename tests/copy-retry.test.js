import test from 'node:test'
import assert from 'node:assert/strict'
import {COPY_RETRY_DELAY_MS,retryCopy,retryableCopyTransport} from '../apps/web/src/copy-retry.ts'

test('retries confirmed transient failures at most three times',async()=>{
  let calls=0,waits=0
  const value=await retryCopy(async()=>{calls++;return {error:'temporary',retryable:true}},async()=>{waits++;return true},()=>true)
  assert.equal(value.error,'temporary')
  assert.equal(calls,4)
  assert.equal(waits,3)
})

test('does not retry permanent, uncertain or cancelled failures',async()=>{
  for(const result of [{error:'permanent'}, {error:'uncertain',retryable:false}]){
    let calls=0
    await retryCopy(async()=>{calls++;return result},async()=>true,()=>true)
    assert.equal(calls,1)
  }
  let calls=0
  await retryCopy(async()=>{calls++;return {error:'temporary',retryable:true}},async()=>false,()=>true)
  assert.equal(calls,1)
})

test('does not retry after context changes during the delay',async()=>{
  let calls=0,active=true
  await retryCopy(async()=>{calls++;return {error:'temporary',retryable:true}},async()=>{active=false;return true},()=>active)
  assert.equal(calls,1)
})

test('retries transport loss without treating authorization errors as transient',()=>{
  assert.equal(retryableCopyTransport('connection_failed'),true)
  assert.equal(retryableCopyTransport('timed_out'),true)
  assert.equal(retryableCopyTransport('invalid_profile'),false)
  assert.equal(retryableCopyTransport('authentication_denied'),false)
})

test('retry delay is thirty seconds',()=>{assert.equal(COPY_RETRY_DELAY_MS,30000)})
