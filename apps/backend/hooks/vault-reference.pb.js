onRecordValidate(e=>{
  if(e.record.getString('credential')!==e.record.original().getString('credential')){
    try{require(__hooks+'/lib/vault-reference.js').normalize(JSON.parse(e.record.getString('credential')||'null'))}
    catch(_){throw new BadRequestError('Invalid 1Password reference',{credential:new ValidationError('invalid_reference','Choose a 1Password account, vault and item. Store only their references here.')})}
  }
  return e.next()
},'workspaces','servers')
