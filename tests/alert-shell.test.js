import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {parse} from '@vue/compiler-sfc'
import {baseParse} from '@vue/compiler-dom'
import {materialSymbol} from '../apps/web/src/icons.ts'
import {leadingRowActions} from '../apps/web/src/table-columns.ts'

test('application startup installs incident confirmation and notification plugins',async()=>{
  const source=readFileSync(new URL('../apps/web/src/main.ts',import.meta.url),'utf8').replace(/^import .*\n/gm,'').replace('void start()','')
  const context={materialSymbol,Quasar:{iconSet:{}},Notify:{name:'Notify'},Dialog:{name:'Dialog'},App:{},en:{},iconSet:{},dark:{value:false},desktopBackendError:{value:false},initializeDesktopBackend:async()=>{},createApp:()=>({use:(_plugin,options)=>{context.options=options;return {mount:()=>{context.mounted=true}}}})}
  await vm.runInNewContext(ts.transpileModule(source+'\nstart()',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context)
  assert.equal(context.mounted,true)
  assert.equal(context.options.plugins.Dialog,context.Dialog)
  assert.equal(context.options.plugins.Notify,context.Notify)
  assert.equal(context.Quasar.iconSet.iconMapFn,materialSymbol)
})

test('the notification controller survives every signed-in layout branch',()=>{
  const {descriptor}=parse(readFileSync(new URL('../apps/web/src/App.vue',import.meta.url),'utf8'))
  const root=baseParse(descriptor.template.content).children.filter(node=>node.type===1)
  assert.equal(root.length,1)
  assert.equal(root[0].tag,'IncidentNotifications')
  const layouts=root[0].children.filter(node=>node.type===1)
  assert.deepEqual(layouts.map(node=>node.tag),['q-layout','q-layout','q-layout','MainLayout'])
  assert.equal(root[0].props.some(prop=>prop.name==='bind' && prop.arg?.content==='key'),false)
  for(const layout of layouts) {
    const find=node=>node.tag==='IncidentNotificationIndicator'||node.children?.some(find)
    assert.ok(find(layout),layout.tag+' needs an incident indicator')
  }
})

test('read inventory tokens show independent alert write permissions and empty capabilities',()=>{
  const source=readFileSync(new URL('../apps/web/src/components/ApiTokensPage.vue',import.meta.url),'utf8')
  const fn=source.slice(source.indexOf('function scopeLabel'),source.indexOf('const selected ='))
  const columns=source.slice(source.indexOf('const columns ='),source.indexOf('const expired ='))
  const context={leadingRowActions,computed:fn=>({value:fn()}),t:value=>value,locale:{value:'en'},result:null}
  vm.runInNewContext(ts.transpileModule(fn+columns+'\nresult=columns.value',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context)
  const token={scope:'read',capabilities:['alerts:write','incidents:resolve']}
  const scope=context.result.find(row=>row.name==='scope'),caps=context.result.find(row=>row.name==='capabilities')
  assert.equal(scope.label,'Inventory permission')
  assert.equal(scope.field(token),'Read only')
  assert.equal(caps.label,'Additional API permissions')
  assert.equal(caps.field(token),'Manage alerts, Resolve incidents')
  assert.equal(caps.field({}),'No additional permissions')
})
