export interface PowerJob {
  action:string
  status:string
  stage:string
  reason?:string
  updated?:string
}

export function selectPowerResult(jobs:PowerJob[]):PowerJob|undefined {
  const blocking=jobs.find(job=>['running','unknown'].includes(job.status))
  if(blocking)return blocking
  const latest=jobs[0],operation=jobs.find(job=>job.action!=='inspect'&&job.status!=='reconciled')
  if(latest?.stage==='provider_on'&&operation&&['requires_console','awaiting_agent','recovered'].includes(operation.status))return operation
  return latest
}

export function presentPowerResult(job:PowerJob,remoteUnlockConfigured:boolean) {
  if(job.status==='recovered')return {tone:'positive',icon:'check_circle',title:'power.result.ready',detail:'power.result.readyHelp',console:false}
  if(job.status==='requires_console')return {tone:'warning',icon:'lock',title:'power.result.pendingUnlock',detail:job.reason==='boot_unavailable'&&!remoteUnlockConfigured?'power.result.unlockNotConfigured':'power.result.consoleHelp',console:true}
  if(job.status==='awaiting_agent')return {tone:'info',icon:'hourglass_empty',title:'power.result.awaitingConfirmation',detail:'power.result.awaitingConfirmationHelp',console:false}
  if(job.status==='failed'&&['boot_unavailable','boot_identity_mismatch','disk_key_rejected','unlock_unconfirmed'].includes(job.reason||''))return {tone:'warning',icon:'lock',title:'power.result.pendingUnlock',detail:'power.error.'+job.reason,console:true}
  if(job.status==='unknown')return {tone:'warning',icon:'help_outline',title:'power.stage.unknown',detail:job.reason?'power.error.'+job.reason:'',console:true}
  if(job.status==='failed')return {tone:'negative',icon:'error_outline',title:'power.stage.failed',detail:job.reason?'power.error.'+job.reason:'',console:false}
  return {tone:job.stage==='powered_off'?'positive':'info',icon:job.stage==='provider_on'?'power_settings_new':'info_outline',title:'power.stage.'+job.stage,detail:'',console:false}
}
