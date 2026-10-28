import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { guideBlocks, guideText } from '../apps/web/src/agent-guide.ts'
import { readRoute, routeHash } from '../apps/web/src/routes.ts'
import { protectedRoute } from '../apps/web/src/auth-routing.ts'

test('installation guide preserves shell commands and troubleshooting tables',()=>{
 const source=readFileSync(new URL('../docs/install-agent.pt-BR.md',import.meta.url),'utf8')
 const blocks=guideBlocks(source)
 assert.ok(blocks.some(b=>b.type==='code' && b.text.includes('sudo sh install.sh \\\n')))
 assert.ok(blocks.some(b=>b.type==='table' && b.rows.some(row=>row[0]==='`API HTTP 401`')))
 assert.ok(blocks.some(b=>b.type==='heading' && b.text==='10. Parar ou remover'))
 assert.deepEqual(guideText('Use `config.json` e **Telemetria**.'),[{type:'span',text:'Use '},{type:'code',text:'config.json'},{type:'span',text:' e '},{type:'strong',text:'Telemetria'},{type:'span',text:'.'}])
})
test('server installation route survives login and links to scoped telemetry',()=>{
 const hash='#/servers/testserver12345/agent-installation'
 assert.deepEqual(readRoute(hash),{view:'agentInstall',server:'testserver12345'})
 assert.equal(protectedRoute(hash,false).returnTo,hash)
 assert.equal(readRoute(routeHash({view:'telemetry',server:'testserver12345'})).server,'testserver12345')
})

test('every guide language preserves installation steps and executable commands',()=>{
 const load=lang=>guideBlocks(readFileSync(new URL(`../docs/install-agent.${lang}.md`,import.meta.url),'utf8'))
 const original=load('pt-BR')
 for(const lang of ['en','uk']) {
  const translated=load(lang)
  assert.deepEqual(translated.map(b=>b.type),original.map(b=>b.type))
  assert.equal(translated.filter(b=>b.type==='heading').length,11)
  const commands=blocks=>blocks.filter(b=>b.type==='code').map(b=>b.text.replace(/i7ya_[A-Z_]+/g,'CREDENTIAL'))
  assert.deepEqual(commands(translated),commands(original))
  assert.notEqual(translated[0].text,original[0].text)
 }
})
