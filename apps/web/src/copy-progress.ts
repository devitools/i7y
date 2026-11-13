export const copyStages = ['backup', 'files', 'database', 'restore', 'domain', 'start', 'verify'] as const
export const copyStageLabels: Record<string, string> = {backup:'Database backup',files:'Project files and configuration',database:'Destination database',restore:'Database restoration',domain:'Site domain',start:'Start containers',verify:'Verify copied site'}
export interface CopyStep {name:string;stage?:string|null;state:string;error?:string;rc?:number}
export function summarizeCopySteps(steps:CopyStep[]) {
 return copyStages.map(id=>{
  const entries=steps.filter(step=>step.stage===id)
  const failed=entries.find(step=>step.state==='failed')
  const running=entries.find(step=>step.state==='running')
  return {id,label:copyStageLabels[id],state:failed?'failed':running?'running':entries.length?entries.every(step=>step.state==='reused')?'reused':'completed':'pending'}
 })
}
