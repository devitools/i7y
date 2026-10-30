import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {parse} from '@vue/compiler-sfc'
import {computed,ref,watch,nextTick,effectScope} from 'vue'

function approval(t){
  const source=readFileSync(new URL('../apps/web/src/components/DesktopApproval.vue',import.meta.url),'utf8')
  const script=parse(source).descriptor.scriptSetup.content.replace(/^import .*\n/gm,'')
  const scope=effectScope(),layouts=[]
  let requestId='request-a',refreshCount=0
  const context={computed,ref,watch,nextTick,onMounted:()=>{},onUnmounted:()=>{},localStorage:{getItem:()=>null},languageOptions:[],locale:ref('en'),dark:ref(false),t:value=>value,clientName:()=> 'Fixture',actionSummary:()=>[],actionDetails:()=>[]}
  context.invoke=async(name,args)=>{
    if(name==='mcp_approval_layout'){layouts.push(args);return}
    assert.equal(name,'mcp_approval_current')
    return requestId?{request:{id:requestId,tool:'save_alert_rule'},client:{name:'Fixture'},poll:++refreshCount}:null
  }
  scope.run(()=>vm.runInNewContext(ts.transpileModule(script+'\nglobalThis.approval={refresh,detail,showDetails,showTechnical}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context))
  t.after(()=>scope.stop())
  return {...context.approval,layouts,setRequest:id=>{requestId=id}}
}

test('unchanged approval polling does not resize or recenter the native authentication window',async t=>{
  const page=approval(t)
  await page.refresh()
  await nextTick()
  assert.equal(page.layouts.length,1)
  const initial=page.detail.value
  for(let i=0;i<8;i++){
    await page.refresh()
    await nextTick()
  }
  assert.notEqual(page.detail.value,initial)
  assert.equal(page.layouts.length,1)
  assert.deepEqual({...page.layouts[0]},{requestId:'request-a',expanded:false,technical:false})
})

test('request and disclosure changes still update native approval layout',async t=>{
  const page=approval(t)
  await page.refresh()
  await nextTick()
  page.showDetails.value=true
  await nextTick()
  assert.deepEqual({...page.layouts.at(-1)},{requestId:'request-a',expanded:true,technical:false})
  page.showTechnical.value=true
  await nextTick()
  assert.deepEqual({...page.layouts.at(-1)},{requestId:'request-a',expanded:true,technical:true})
  await page.refresh()
  await nextTick()
  assert.equal(page.layouts.length,3)
  page.setRequest('request-b')
  await page.refresh()
  await nextTick()
  assert.equal(page.layouts.length,4)
  assert.deepEqual({...page.layouts.at(-1)},{requestId:'request-b',expanded:false,technical:false})
  page.setRequest(null)
  await page.refresh()
  await nextTick()
  assert.equal(page.layouts.length,4)
})
