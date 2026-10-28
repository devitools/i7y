import type { SendOptions } from 'pocketbase'
export function createOrganizationTransport(getOrganization: () => string | null, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
  let generation=0
  const responses=new WeakMap<Response, number>()
  const assertCurrent=(version: number)=>{if(version!==generation)throw new Error('Organization context changed')}
  return {
    invalidate(){generation++},
    beforeSend(url: string,options: SendOptions){
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
    afterSend<T>(response: Response,data: T): T{assertCurrent(responses.get(response));return data},
  }
}
