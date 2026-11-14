import test from 'node:test'
import assert from 'node:assert/strict'
import {mcpPort,mcpConnectionJson} from '../apps/web/src/mcp-connection.ts'

test('local MCP port accepts only explicit whole-number ports in the allowed range',()=>{
  for(const value of [null,undefined,false,{},[],0,1023,65536,1.5,Infinity,NaN,'','1e4','47831x','1.0','-1'])assert.equal(mcpPort(value),null)
  for(const value of [1024,47831,65535,'47831',' 49000 '])assert.equal(mcpPort(value),Number(value))
})

test('connection exports describe HTTP rather than a client-specific configuration file',()=>{
  const connection={ready:true,url:'http://127.0.0.1:49000/mcp',authorization:'Bearer fixture'}
  assert.deepEqual(JSON.parse(mcpConnectionJson(connection)),{transport:'streamable_http',url:connection.url,headers:{Authorization:connection.authorization}})
  assert.equal(JSON.parse(mcpConnectionJson(connection,true)).headers.Authorization,'Bearer <local-token>')
  assert.equal(mcpConnectionJson({...connection,ready:false}),'')
})
