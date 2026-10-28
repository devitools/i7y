export async function deleteContainers(ids, remove) {
  const deleted=[],failed=[]
  for(const id of [...new Set(ids)]) {
    try {await remove(id);deleted.push(id)}
    catch(error) {
      if(error.status===404) deleted.push(id)
      else failed.push({id,error})
    }
  }
  return {deleted,failed}
}
