import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
const context={module:{exports:{}}}
vm.runInNewContext(readFileSync('apps/backend/hooks/lib/vault-reference.js','utf8'),context)
const {normalize}=context.module.exports
const fixture=JSON.parse(readFileSync('tests/fixtures/credential-references.json','utf8'))
test('backend reference normalizer accepts the versioned generic contract and preserves legacy vault identity',()=>{
  for(const {input,expected} of fixture.valid)assert.deepEqual(JSON.parse(JSON.stringify(normalize(input))),expected)
  for(const input of fixture.invalid)assert.throws(()=>normalize(input),/Invalid credential reference/)
})
test('canonicalizing an existing reference is stable without a destructive data migration',()=>{
  const raw={provider:'1password',account:'Disk Ninja',vault:'Infrastructure',item:'VPN'}
  const before=JSON.stringify(raw),normalized=normalize(raw)
  assert.equal(JSON.stringify(raw),before)
  assert.equal(JSON.stringify(normalize(normalized)),JSON.stringify(normalized))
  assert.equal(JSON.stringify(normalize({version:2,vault:'1password',item:'VM'})),JSON.stringify(normalize({version:2,vault:'1password',account:'',item:'VM',options:{vault:''}})))
})
