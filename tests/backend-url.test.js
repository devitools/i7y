import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBackendUrl } from '../apps/web/src/backend-url.ts'

test('backend URL accepts HTTPS and loopback while rejecting embedded credentials and unsafe schemes',()=>{
  assert.equal(normalizeBackendUrl(' https://inventory.example.com/i7y '),'https://inventory.example.com/i7y/')
  for(const host of ['localhost','127.0.0.1','[::1]'])assert.equal(normalizeBackendUrl(`http://${host}:8097`),`http://${host}:8097/`)
  for(const invalid of ['', 'not a URL','http://inventory.example.com','ftp://inventory.example.com','https://user:secret@example.com','https://example.com/?token=secret','https://example.com/#login'])assert.throws(()=>normalizeBackendUrl(invalid))
})
