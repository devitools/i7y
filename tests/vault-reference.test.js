import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {computed,ref} from 'vue'
import {credentialManagers,credentialReference,savedCredentialReference,credentialManagerLabel} from '../apps/web/src/vault-reference.ts'

const plain=value=>JSON.parse(JSON.stringify(value))
test('frontend and backend normalize the same shared credential fixtures without losing options',()=>{
  const fixtures=JSON.parse(readFileSync('tests/fixtures/credential-references.json','utf8'))
  const backend={module:{exports:{}}}
  vm.runInNewContext(readFileSync('apps/backend/hooks/lib/vault-reference.js','utf8'),backend)
  for(const {input,expected} of fixtures.valid){
    assert.deepEqual(plain(savedCredentialReference(input)),expected)
    assert.deepEqual(plain(backend.module.exports.normalize(input)),expected)
    if(expected)assert.deepEqual(credentialReference(input),expected)
  }
  for(const input of fixtures.invalid){
    assert.throws(()=>savedCredentialReference(input),/vault.invalidReference/)
    assert.throws(()=>backend.module.exports.normalize(input),/Invalid credential reference/)
  }
})

test('credential references normalize legacy vaults without changing the account or item',()=>{
  const expected={version:2,vault:'1password',account:'account.example.com',item:'VPN',options:{vault:'Infrastructure'}}
  assert.deepEqual(savedCredentialReference({provider:'1password',account:'account.example.com',vault:'Infrastructure',item:'VPN'}),expected)
  assert.deepEqual(savedCredentialReference(expected),expected)
  assert.deepEqual(credentialReference({vault:'Infrastructure',item:'VPN'}),{...expected,account:''})
  assert.deepEqual(savedCredentialReference({vault:'1password',item:'VPN'}),{version:2,vault:'1password',account:'',item:'VPN',options:{vault:'1password'}})
})

test('generic references permit item-only resolution and preserve unsupported manager identity',()=>{
  assert.deepEqual(savedCredentialReference({version:2,vault:'1password',account:'Disk Ninja',item:'SNEL VPN VPS Server'}),{version:2,vault:'1password',account:'Disk Ninja',item:'SNEL VPN VPS Server'})
  const other={version:2,vault:'future-manager',account:'',item:'VPN'}
  assert.deepEqual(savedCredentialReference(other),other)
  assert.equal(credentialManagerLabel(other),'future-manager')
  assert.equal(credentialManagerLabel({vault:'Infrastructure',item:'VPN'}),'1Password')
  assert.equal(savedCredentialReference(null),null)
  assert.deepEqual(credentialReference(null),{version:2,vault:'1password',account:'',item:''})
  assert.throws(()=>savedCredentialReference({version:2,vault:'1password',account:'',item:'',options:{vault:'Legacy'}}),/vault.invalidReference/)
})

test('credential serialization rejects extra fields secrets and malformed values without silently discarding them',()=>{
  const input={version:2,vault:'1password',account:'a',item:'i',options:{vault:'legacy'}}
  for(const change of [{password:'never-export'},{token:'never-export'},{version:3},{version:'2'},{vault:'--help'},{vault:'Bad manager'},{vault:'x'.repeat(41)},{account:'--help'},{item:'a\nb'},{item:' VM '},{item:'x'.repeat(241)},{item:42},{options:{vault:42}},{options:{password:'never-export'}},{options:{private_key:'never-export'}},{options:{vault:' legacy '}},{options:{vault:'-flag'}},{options:{vault:'x'.repeat(241)}},{options:Object.fromEntries(Array.from({length:9},(_,i)=>['field'+i,'value']))}])assert.throws(()=>savedCredentialReference({...input,...change}),/vault.invalidReference/)
  for(const key of ['BadKey','project-name','1region','x'.repeat(65),'api_key','credential_id','authorization','passphrase','otp'])assert.throws(()=>savedCredentialReference({...input,vault:'future-vault',options:{[key]:'value'}}),/vault.invalidReference/)
  assert.throws(()=>savedCredentialReference({version:2,vault:'1password',account:'account'}),/vault.invalidReference/)
  assert.throws(()=>credentialReference({version:3,vault:'future-manager',item:'i'}),/vault.invalidReference/)
  assert.throws(()=>credentialReference({version:'2',vault:'1password',item:'i'}),/vault.invalidReference/)
})

function editorHarness(resource='servers',action='edit',initial){
  let stored=initial??{id:'server',name:'VPN',workspace:'workspace',type:'VPS',status:'SUSPENDED',inventory_known:false,sort_order:71,credential:{vault:'Infrastructure',item:'Old item'}}
  const calls=[],props={route:{view:'manage',resource,action,...(action==='edit'?{id:stored.id}:{})},canEdit:true}
  const context={computed,ref,watch:()=>{},onUnmounted:()=>{},AbortController,defineProps:()=>props,defineEmits:()=>()=>{},useQuasar:()=>({notify:()=>{}}),desktopRuntime:false,desktopBackend:{value:'https://fixture.test/'},repositoryHref:()=>true,versionControlLabel:x=>x,t:x=>x,credentialManagers,credentialReference,savedCredentialReference,inventoryPage:async()=>({items:[{id:'workspace',login:'Fixture'}]}),management:{get:async()=>structuredClone(stored),update:async(resource,id,body)=>{calls.push({method:'update',resource,id,body});stored={...stored,...structuredClone(body)}},create:async(resource,body)=>{calls.push({method:'create',resource,body})}}}
  const script=readFileSync('apps/web/src/components/ManagementPage.vue','utf8').match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1].replace(/^import .*\n/gm,'')
  vm.runInNewContext(ts.transpileModule(script+'\nglobalThis.editor={load,submit,form,credentialManagerOptions}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context)
  return {calls,props,...context.editor}
}

test('editing a server credential preserves hidden legacy vault metadata and collector fields',async()=>{
  const editor=editorHarness()
  await editor.load()
  editor.form.value.credential.account=' Disk Ninja '
  editor.form.value.credential.item=' New item '
  await editor.submit()
  assert.equal(editor.calls.length,1)
  assert.deepEqual(plain(editor.calls[0].body.credential),{version:2,vault:'1password',account:'Disk Ninja',item:'New item',options:{vault:'Infrastructure'}})
  for(const key of ['status','inventory_known','sort_order'])assert.equal(Object.hasOwn(editor.calls[0].body,key),false)
  await editor.load()
  assert.equal(editor.form.value.status,'SUSPENDED')
  assert.equal(editor.form.value.inventory_known,false)
  assert.equal(editor.form.value.sort_order,71)
  assert.equal(editor.form.value.credential.options.vault,'Infrastructure')
})

test('new resources omit collector fields and project creation does not modify its server',async()=>{
  for(const resource of ['servers','projects','containers']){
    const editor=editorHarness(resource,'new')
    await editor.load()
    for(const key of ['status','inventory_known','sort_order'])assert.equal(Object.hasOwn(editor.form.value,key),false)
    Object.assign(editor.form.value,{server:'existing-server',name:'Example',status:'ACTIVE',inventory_known:true,sort_order:999})
    await editor.submit()
    assert.equal(editor.calls.length,1)
    assert.equal(editor.calls[0].method,'create')
    assert.equal(editor.calls[0].resource,resource)
    for(const key of ['status','inventory_known','sort_order'])assert.equal(Object.hasOwn(editor.calls[0].body,key),false)
  }
})

test('an unrelated workspace edit preserves the future manager and every hidden adapter option',async()=>{
  const reference={version:2,vault:'future-vault',account:'Team',item:'VM',options:{project:'fixture',region:'test'}}
  const editor=editorHarness('workspaces','edit',{id:'workspace',login:'Workspace',provider:'SNEL',credential:reference})
  await editor.load()
  const option=editor.credentialManagerOptions.value.find(option=>option.value==='future-vault')
  assert.equal(option.disable,true)
  editor.form.value.login='Renamed workspace'
  await editor.submit()
  assert.equal(editor.calls[0].body.login,'Renamed workspace')
  assert.deepEqual(plain(editor.calls[0].body.credential),reference)
  await editor.load()
  assert.deepEqual(plain(editor.form.value.credential),reference)
})

test('clearing the visible credential fields removes a legacy reference with hidden options',async()=>{
  const editor=editorHarness()
  await editor.load()
  assert.equal(editor.form.value.credential.options.vault,'Infrastructure')
  editor.form.value.credential.account=' '
  editor.form.value.credential.item=' '
  await editor.submit()
  assert.equal(editor.calls.length,1)
  assert.equal(editor.calls[0].body.credential,null)
})
