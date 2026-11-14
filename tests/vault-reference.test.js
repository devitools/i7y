import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {computed,ref} from 'vue'
import {savedVaultReference,vaultReference} from '../apps/web/src/vault-reference.ts'

test('legacy references remain usable and account vault and item survive serialization',()=>{
  assert.deepEqual(vaultReference({vault:'Infrastructure',item:'VPN'}),{provider:'1password',account:'',vault:'Infrastructure',item:'VPN'})
  assert.deepEqual(savedVaultReference({provider:'1password',account:' account.example.com ',vault:' Infrastructure ',item:' VPN '}),{provider:'1password',account:'account.example.com',vault:'Infrastructure',item:'VPN'})
  assert.equal(savedVaultReference({provider:'1password',account:'',vault:'',item:''}),null)
  for(const value of [{vault:'Infrastructure'},{item:'VPN'},{provider:'other',vault:'v',item:'i'},{account:'--help',vault:'v',item:'i'}])assert.throws(()=>savedVaultReference(value),/vault.invalidReference/)
})

test('the server editor saves a changed account reference and loads it on reopening',async()=>{
  let stored={id:'server',name:'VPN',workspace:'workspace',type:'VPS',credential:{vault:'Infrastructure',item:'Old item'}}
  const calls=[],props={route:{view:'manage',resource:'servers',action:'edit',id:'server'},canEdit:true}
  const context={computed,ref,watch:()=>{},onUnmounted:()=>{},AbortController,defineProps:()=>props,defineEmits:()=>()=>{},useQuasar:()=>({notify:()=>{}}),desktopRuntime:false,desktopBackend:{value:'https://fixture.test/'},repositoryHref:()=>true,versionControlLabel:x=>x,t:x=>x,vaultReference,savedVaultReference,inventoryPage:async()=>({items:[{id:'workspace',login:'Fixture'}]}),management:{get:async()=>structuredClone(stored),update:async(resource,id,body)=>{calls.push({resource,id,body});stored={...stored,...structuredClone(body)}}}}
  const script=readFileSync('apps/web/src/components/ManagementPage.vue','utf8').match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1].replace(/^import .*\n/gm,'')
  vm.runInNewContext(ts.transpileModule(script+'\nglobalThis.editor={load,submit,form}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context)
  await context.editor.load()
  context.editor.form.value.credential={provider:'1password',account:'new.example.com',vault:'New vault',item:'New item'}
  await context.editor.submit()
  assert.equal(calls.length,1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body.credential)),{provider:'1password',account:'new.example.com',vault:'New vault',item:'New item'})
  await context.editor.load()
  assert.deepEqual(JSON.parse(JSON.stringify(context.editor.form.value.credential)),JSON.parse(JSON.stringify(stored.credential)))
})
