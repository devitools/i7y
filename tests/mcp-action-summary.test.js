import test from 'node:test'
import assert from 'node:assert/strict'
import {actionSummary} from '../apps/web/src/mcp-action-summary.ts'

test('operation review shows the action and target from the immutable saved plan',()=>{
  const request={tool:'submit_operation',arguments:{operation_id:'job-1',__reviewed_plan:{plan:{action:'container_stop',target:'container-1'},approval:'opaque-proof'}}}
  const before=JSON.stringify(request)
  assert.deepEqual(actionSummary(request),[{label:'Action',value:'Stop container'},{label:'Target',value:'container-1'},{label:'Operation',value:'job-1'}])
  assert.equal(JSON.stringify(request),before)
})

test('rule review preserves zero thresholds and incident review excludes evidence from the summary',()=>{
  assert.deepEqual(actionSummary({tool:'save_alert_rule',arguments:{rule:{name:'Containers',scope_id:'server-1',condition:{metric:'containers.running',operator:'eq',value:0}}}}),[{label:'Name',value:'Containers'},{label:'Target',value:'server-1'},{label:'Condition',value:'containers.running eq 0'}])
  const args={title:'Push test',resource_name:'Moto G10',severity:'info',evidence:{description:'Long evidence'}}
  assert.deepEqual(actionSummary({tool:'create_incident',arguments:args}),[{label:'Title',value:'Push test'},{label:'Target',value:'Moto G10'},{label:'Severity',value:'info'}])
  assert.equal(args.evidence.description,'Long evidence')
})
