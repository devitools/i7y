import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import en from '../apps/web/src/locales/en/alerts.ts'
import ptBR from '../apps/web/src/locales/pt-BR/alerts.ts'
import uk from '../apps/web/src/locales/uk/alerts.ts'

function apiHarness(respond = async () => ({id:'fixture',items:[]})) {
  const calls = []
  const pb = {baseURL:'/backend/',send:async (path,options) => {calls.push({path,options});return respond(path,options)}}
  const source = ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/alerts-api.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const context = {exports:{},require:name => {assert.equal(name,'./api');return {pb}},URL,window:{location:{origin:'https://inventory.example.test'}}}
  vm.runInNewContext(source,context)
  return {...context.exports,calls}
}

test('missing backend endpoints and HTML fallback responses produce a compatibility error',async()=>{
  for(const result of [{},'<html>i7y</html>',null]) {
    const api=apiHarness(async()=>result)
    await assert.rejects(api.alertsApi.rules(),error=>api.alertLoadError(error,'alerts.loadError')==='alerts.backendUnavailable')
    await assert.rejects(api.alertsApi.incidents(),error=>error.code==='alerts_api_unavailable')
  }
  const missing=apiHarness(async()=>{throw {status:404}})
  await assert.rejects(missing.alertsApi.metrics(),error=>error.code==='alerts_api_unavailable')
  await assert.rejects(missing.alertsApi.rule('missing'),error=>error.status===404)
  const denied=apiHarness(async()=>{throw {status:403}})
  await assert.rejects(denied.alertsApi.rules(),error=>denied.alertLoadError(error,'alerts.loadError')==='alerts.loadError' && error.status===403)
})

test('incident claims stay open, become overdue at deadline, and resolved wins',() => {
  const {incidentPhase} = apiHarness()
  const deadline = Date.parse('2026-10-28T12:00:00Z')
  const claimed = {status:'open',assignee:'user',claim_until:'2026-10-28 12:00:00.000Z'}
  assert.equal(incidentPhase(claimed,deadline-1),'inProgress')
  assert.equal(incidentPhase(claimed,deadline),'overdue')
  assert.equal(incidentPhase({...claimed,status:'resolved'},deadline-1),'resolved')
  assert.equal(incidentPhase({...claimed,assignee:''},deadline+1),'open')
})

test('configuration lists include later pages and requests reuse the shared client',async () => {
  const api = apiHarness(async (_path,options) => ({items:[{id:options.query.page}],totalPages:3}))
  const result = await api.alertsApi.rules()
  assert.deepEqual(Array.from(result.items,row=>row.id),[1,2,3])
  assert.equal(api.calls.length,3)
  assert.ok(api.calls.every(call=>call.options.requestKey===null && call.options.query.perPage===100))
})

test('claim requests preserve concurrency version and deadline without delivery acknowledgements',async () => {
  const api = apiHarness()
  await api.alertsApi.claim('incident/id','2026-10-28T12:00:00Z',7)
  await api.alertsApi.notifications('42')
  assert.equal(api.calls[0].path,'/api/i7y/alerts/v1/incidents/incident%2Fid/claim')
  assert.equal(api.calls[0].options.body.version,7)
  assert.equal(api.calls[0].options.body.claim_until,'2026-10-28T12:00:00Z')
  assert.equal(api.calls[1].options.method,'GET')
  assert.equal(api.calls[1].options.body,undefined)
  assert.equal(api.calls[1].options.query.cursor,'42')
})

test('integration endpoints support relative backend bases and encode identifiers',() => {
  const api = apiHarness()
  assert.equal(api.integrationEndpoint({id:'a/b',kind:'gcp'}),'https://inventory.example.test/api/i7y/alerts/v1/integrations/a%2Fb/gcp')
  assert.equal(api.integrationEndpoint({id:'example',kind:'generic'}),'https://inventory.example.test/api/i7y/alerts/v1/integrations/example/events')
})

test('all alert and incident UI strings exist in every supported locale',() => {
  const expected = Object.keys(en).sort()
  for (const dictionary of [ptBR,uk]) {
    assert.deepEqual(Object.keys(dictionary).sort(),expected)
    assert.ok(Object.values(dictionary).every(value=>typeof value==='string' && value.trim()))
  }
  for (const name of ['AlertsPage','IncidentsPage','IncidentNotifications']) {
    const source = fs.readFileSync(new URL(`../apps/web/src/components/${name}.vue`,import.meta.url),'utf8')
    for (const match of source.matchAll(/\bt\('((?:alerts|incidents)\.[^']+)'\)/g)) {
      if (match[1].endsWith('.')) continue
      assert.ok(en[match[1]],`${name}: ${match[1]}`)
    }
    assert.equal(source.includes('v-html'),false)
  }
})

test('rule and integration reminder fields share the backend seven-day bound',() => {
  const source = fs.readFileSync(new URL('../apps/web/src/components/AlertsPage.vue',import.meta.url),'utf8')
  assert.ok(source.includes('Number(value) <= 604800'))
  assert.equal((source.match(/min="60" max="604800"/g) || []).length,2)
  assert.equal(source.includes('2592000'),false)
  for (const dictionary of [en,ptBR,uk]) assert.ok(dictionary['alerts.reminderRange'].includes('604800'))
})

function componentFunction(component, name, overrides = {}) {
  const source = fs.readFileSync(new URL(`../apps/web/src/components/${component}.vue`,import.meta.url),'utf8').match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1]
  const ast = ts.createSourceFile(component+'.ts',source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS)
  const declaration = ast.statements.find(node=>ts.isFunctionDeclaration(node) && node.name?.text===name)
  assert.ok(declaration,`${component}.${name}`)
  const calls = []
  let confirmation
  const context = {
    props:{canEdit:true},activeOrganization:{value:'org-a'},generation:1,contextGeneration:1,
    detailId:{value:'incident-a'},incident:{value:{id:'incident-a',status:'open',origin:'rule',version:7}},
    busy:{value:false},error:{value:''},secret:{value:''},integrations:{value:[]},t:key=>key,
    q:{dialog:()=>({onOk:callback=>{confirmation=callback}})},
    alertsApi:{
      archiveRule:async key=>{calls.push(['archive',key])},
      rotateIntegration:async id=>{calls.push(['rotate',id]);return {id,token:'secret'}},
      revokeIntegration:async id=>{calls.push(['revoke',id])},
      integrations:async ()=>{calls.push(['integrations']);return {items:[]}},
      resolve:async (id,version)=>{calls.push(['resolve',id,version])},
    },
    load:async ()=>{calls.push(['load'])},captureSecret:result=>{calls.push(['secret',result.integration.id])},
    ...overrides,
  }
  vm.createContext(context)
  vm.runInContext(ts.transpileModule(declaration.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context)
  return {context,calls,invoke:(...args)=>context[name](...args),confirm:()=>confirmation()}
}

test('archive confirmation cannot carry an old rule into a new organization or route',async () => {
  for (const change of [context=>{context.activeOrganization.value='org-b'},context=>{context.generation++}]) {
    const action=componentFunction('AlertsPage','archive')
    action.invoke({key:'original-rule'})
    change(action.context)
    await action.confirm()
    assert.deepEqual(action.calls,[])
  }
  const action=componentFunction('AlertsPage','archive'),rule={key:'original-rule'}
  action.invoke(rule)
  rule.key='replacement-rule'
  await action.confirm()
  assert.deepEqual(action.calls,[['archive','original-rule'],['load']])
})

test('integration revoke and rotation confirmations retain their original context and ID',async () => {
  for (const rotate of [true,false]) {
    const stale=componentFunction('AlertsPage','integrationAction')
    stale.invoke({id:'integration-a'},rotate)
    stale.context.generation++
    await stale.confirm()
    assert.deepEqual(stale.calls,[])
    const action=componentFunction('AlertsPage','integrationAction'),row={id:'integration-a'}
    action.invoke(row,rotate)
    row.id='integration-b'
    await action.confirm()
    assert.deepEqual(action.calls[0],[rotate?'rotate':'revoke','integration-a'])
    assert.deepEqual(action.calls[1],['integrations'])
    if(rotate)assert.deepEqual(action.calls[2],['secret','integration-a'])
  }
})

test('incident closure cancels after context changes and preserves the confirmed version',async () => {
  for (const change of [context=>{context.detailId.value='incident-b'},context=>{context.activeOrganization.value='org-b'},context=>{context.contextGeneration++}]) {
    const action=componentFunction('IncidentsPage','resolve')
    action.invoke()
    change(action.context)
    await action.confirm()
    assert.deepEqual(action.calls,[])
  }
  const action=componentFunction('IncidentsPage','resolve')
  action.invoke()
  action.context.generation++
  action.context.incident.value.version=8
  await action.confirm()
  assert.deepEqual(action.calls,[['resolve','incident-a',7],['load']])
})

test('preview badges distinguish string match results from unknown observations',() => {
  const preview=componentFunction('AlertsPage','previewColor')
  for(const match of ['true',true])assert.equal(preview.invoke(match),'negative')
  for(const healthy of ['false',false])assert.equal(preview.invoke(healthy),'positive')
  for(const unknown of ['unknown','skipped',null,undefined])assert.equal(preview.invoke(unknown),'grey')
})

test('clearing alert search preserves the list and subsequent searches still filter',() => {
  const source = fs.readFileSync(new URL('../apps/web/src/components/AlertsPage.vue',import.meta.url),'utf8').match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1]
  const ast = ts.createSourceFile('AlertsPage.ts',source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS)
  const declaration = ast.statements.filter(ts.isVariableStatement).flatMap(statement=>Array.from(statement.declarationList.declarations)).find(node=>node.name.getText(ast)==='filteredRules')
  assert.ok(declaration)
  const context = {
    computed:callback=>({get value(){return callback()}}),
    rules:{value:[{name:'Disk capacity',key:'disk',enabled:true,condition:{metric:'host.disk_percent'},target:'Production'},{name:'CPU usage',key:'cpu',enabled:false,condition:{metric:'host.cpu_percent'},target:'Staging'}]},
    ruleSearch:{value:null},ruleStatus:{value:'all'},ruleCondition:{value:null},ruleTarget:{value:null},targetLabel:rule=>rule.target,
  }
  vm.createContext(context)
  vm.runInContext('globalThis.filtered = '+declaration.initializer.getText(ast),context)
  assert.deepEqual(Array.from(context.filtered.value,rule=>rule.key),['disk','cpu'])
  context.ruleSearch.value='DISK'
  assert.deepEqual(Array.from(context.filtered.value,rule=>rule.key),['disk'])
  context.ruleSearch.value=null
  context.ruleStatus.value='disabled'
  assert.deepEqual(Array.from(context.filtered.value,rule=>rule.key),['cpu'])
  context.ruleStatus.value='all'
  context.ruleSearch.value='production'
  assert.deepEqual(Array.from(context.filtered.value,rule=>rule.key),['disk'])
})
