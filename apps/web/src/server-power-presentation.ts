export interface PowerJob {
  action:string
  status:string
  stage:string
  reason?:string
  updated?:string
}

export function selectPowerResult(jobs:PowerJob[]):PowerJob|undefined {
  const running=jobs.find(job=>job.status==='running')
  if(running)return running
  const unknown=jobs.find(job=>job.status==='unknown')
  if(unknown&&!(jobs[0]?.action==='inspect'&&jobs[0]?.status==='observed'))return unknown
  const latest=jobs[0],operation=jobs.find(job=>job.action!=='inspect'&&job.status!=='reconciled')
  if(latest?.stage==='provider_on'&&operation&&['requires_console','awaiting_agent'].includes(operation.status))return operation
  return latest
}

export function presentPowerResult(job:PowerJob,remoteUnlockConfigured:boolean) {
  if(job.action==='inspect'&&job.stage==='disk_locked')return {tone:'warning',icon:'lock',title:'power.result.diskLocked',detail:'power.result.diskLockedHelp',console:true}
  if(job.action==='inspect'&&job.stage==='provider_on')return {tone:'info',icon:'power_settings_new',title:'power.stage.provider_on',detail:'power.result.providerOnHelp',console:false}
  if(job.status==='recovered')return {tone:'positive',icon:'check_circle',title:'power.result.ready',detail:'power.result.readyHelp',console:false}
  if(job.status==='requires_console')return {tone:'warning',icon:'lock',title:'power.result.pendingUnlock',detail:job.reason==='boot_unavailable'&&!remoteUnlockConfigured?'power.result.unlockNotConfigured':'power.result.consoleHelp',console:true}
  if(job.status==='awaiting_agent')return {tone:'info',icon:'hourglass_empty',title:'power.result.awaitingConfirmation',detail:'power.result.awaitingConfirmationHelp',console:false}
  if(job.status==='failed'&&['boot_unavailable','boot_identity_mismatch','disk_key_rejected','unlock_unconfirmed'].includes(job.reason||''))return {tone:'warning',icon:'lock',title:'power.result.pendingUnlock',detail:'power.error.'+job.reason,console:true}
  if(job.status==='unknown')return {tone:'warning',icon:'help_outline',title:'power.stage.unknown',detail:job.reason?'power.error.'+job.reason:'',console:true}
  if(job.status==='failed'&&job.reason==='provider_unavailable')return {tone:'warning',icon:'cloud_off',title:'power.result.providerUnavailable',detail:'power.result.providerUnavailableHelp',console:false}
  if(job.status==='failed')return {tone:'negative',icon:'error_outline',title:'power.stage.failed',detail:job.reason?'power.error.'+job.reason:'',console:false}
  return {tone:job.stage==='powered_off'?'positive':'info',icon:job.stage==='provider_on'?'power_settings_new':'info_outline',title:'power.stage.'+job.stage,detail:'',console:false}
}
