export function createOrganizationTransport(getOrganization, fetcher = (...args) => fetch(...args)) {
  let generation=0
  const responses=new WeakMap()
  const assertCurrent=version=>{if(version!==generation)throw new Error('Organization context changed')}
  return {
    invalidate(){generation++},
    beforeSend(url,options){
      const version=generation,organization=getOrganization()
      options.headers={...options.headers,...(organization?{'X-I7y-Organization':organization}:{})}
      options.fetch=async(input,init)=>{
        const response=await fetcher(input,init)
        assertCurrent(version)
        responses.set(response,version)
        return response
      }
      return {url,options}
    },
    afterSend(response,data){assertCurrent(responses.get(response));return data},
  }
}
