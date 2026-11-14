export function actionSummary(request:any):{label:string;value:string}[]{
  const args=request.arguments || {}
  const rows:{label:string;value:string}[]=[]
  const add=(label:string,value:unknown)=>{if(typeof value==='string'&&value.trim())rows.push({label,value})}
  switch(request.tool){
    case 'create_incident':
      add('Title',args.title)
      add('Target',args.resource_name || args.resource_id)
      add('Severity',args.severity)
      break
    case 'claim_incident':
      add('Incident',args.id)
      add('Claim until',args.claim_until)
      break
    case 'resolve_incident':
      add('Incident',args.id)
      break
    case 'save_alert_rule':
      add('Name',args.rule?.name || args.key)
      add('Target',args.rule?.model_version===2?args.rule?.target_type:args.rule?.scope_id)
      if(args.rule?.reminder_intervals)for(const [severity,seconds] of Object.entries(args.rule.reminder_intervals))add('Reminder '+severity+' (seconds)',String(seconds))
      if(args.rule?.exclusions)add('Exclusions',String(args.rule.exclusions.length))
      if(args.rule?.condition){
        const c=args.rule.condition
        add('Condition',[c.metric,c.operator,c.value ?? c.state].filter(v=>v!==undefined).join(' '))
        if(c.critical_value!==undefined){
          const operator=c.operator==='gte'?'≥':c.operator==='gt'?'>':c.operator
          add('Warning threshold',`${operator} ${c.value}%`)
          add('Critical threshold',`${operator} ${c.critical_value}%`)
        }
      }
      if(args.rule?.duration_seconds!==undefined)add(['host.cpu_percent','host.memory_percent'].includes(args.rule.condition?.metric)&&args.rule.condition.critical_value!==undefined?'Confirmation per severity (seconds)':'Duration (seconds)',String(args.rule.duration_seconds))
      break
    case 'apply_alert_rule_migration':
      add('Action','Consolidate alert rules by resource type')
      add('Plan hash',args.plan_hash)
      if(args.options?.exclusions)add('Exclusions',String(args.options.exclusions.length))
      break
    case 'archive_alert_rule':
      add('Alert rule',args.key)
      break
    case 'submit_operation':{
      const reviewed=args.__reviewed_plan || args.plan || {}
      const plan=reviewed.plan || reviewed
      const actions:Record<string,string>={container_start:'Start container',container_stop:'Stop container',container_restart:'Restart container'}
      add('Action',actions[plan.action] || plan.action)
      add('Target',plan.target)
      add('Operation',args.operation_id)
      break
    }
  }
  return rows
}

export function actionDetails(request:any):{labels:string[];value:string}[]{
  const names:Record<string,string>={model_version:'Rule model version',target_type:'Resource type',reminder_intervals:'Reminders by severity (seconds)',exclusions:'Exclusions',reason:'Reason',plan_hash:'Reviewed plan hash',options:'Migration options',reminder_overrides:'Reminder overrides',no_communication_seconds:'No communication threshold (seconds)',title:'Title',severity:'Severity',resource_type:'Resource type',resource_id:'Resource ID',resource_name:'Resource',reminder_seconds:'Reminder interval (seconds)',evidence:'Evidence',id:'Incident',version:'Version',claim_until:'Claim until',key:'Alert rule',expected_version:'Expected version',rule:'Alert rule',name:'Name',scope_type:'Scope',scope_id:'Target',condition:'Condition',metric:'Metric',operator:'Operator',value:request.arguments?.rule?.condition?.critical_value!==undefined?'Warning threshold (%)':'Value',critical_value:'Critical threshold (%)',disk_path:'Disk path',state:'State',duration_seconds:['host.cpu_percent','host.memory_percent'].includes(request.arguments?.rule?.condition?.metric)&&request.arguments.rule.condition.critical_value!==undefined?'Confirmation per severity (seconds)':'Duration (seconds)',enabled:'Enabled',operation_id:'Operation'}
  const rows:{labels:string[];value:string}[]=[]
  function visit(value:unknown,labels:string[],depth:number){
    if(value!==null&&typeof value==='object'&&depth<6){
      for(const [key,child] of Object.entries(value))visit(child,[...labels,names[key] || key.replaceAll('_',' ')],depth+1)
    }else if(value===null||typeof value!=='object')rows.push({labels,value:value===true?'Yes':value===false?'No':String(value ?? '—')})
  }
  for(const [key,value] of Object.entries(request.arguments || {})){
    if(['client','duration_seconds','__reviewed_plan','plan'].includes(key))continue
    visit(value,[names[key] || key.replaceAll('_',' ')],0)
  }
  return rows
}
