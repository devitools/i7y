for(const action of [onRecordCreateRequest,onRecordUpdateRequest])action(e=>{
  if(e.hasSuperuserAuth())return e.next()
  const previous=e.record.original(),creating=e.requestInfo().method==='POST'
  for(const [name,read,fallback]of [['status','getString',''],['inventory_known','getBool',false],['sort_order','getFloat',0]]){
    if(e.record[read](name)!==(creating?fallback:previous[read](name)))throw new ForbiddenError('Server observations are maintained by collectors')
  }
  return e.next()
},'servers')
