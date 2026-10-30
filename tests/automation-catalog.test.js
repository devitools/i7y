import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,existsSync} from 'node:fs'
const root=new URL('../apps/automation/',import.meta.url)
const catalog=JSON.parse(readFileSync(new URL('actions.json',root),'utf8'))
test('Every legacy operation has a distinct reviewed action',()=>{
  const legacy=['info/server','info/df','info/projects','maintenance/amazon-update','maintenance/centos-update','maintenance/tevun-pull','maintenance/tevun-update','setup/bashrc','setup/docker','setup/mc','setup/ssh','setup/tevun','setup/timezone']
  assert.equal(catalog.version,1)
  assert.equal(new Set(catalog.actions.map(a=>a.id)).size,catalog.actions.length)
  assert.deepEqual(catalog.actions.map(a=>a.legacy).filter(Boolean).sort(),legacy.sort())
  for(const action of catalog.actions){
    assert.match(action.id,/^[a-z]+\.[a-z-]+$/)
    assert.ok(['server','project','container'].includes(action.target))
    assert.ok(['read','write','admin'].includes(action.permission))
    assert.equal(action.enabled,false)
    if(action.recipe){assert.match(action.recipe,/^[a-z-]+\.yml$/);assert.ok(existsSync(new URL('recipes/'+action.recipe,root)))}
  }
})
