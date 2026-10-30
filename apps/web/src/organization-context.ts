import type { SendOptions } from 'pocketbase'
export function createOrganizationTransport(getOrganization: () => string | null, fetcher: typeof fetch = (input, init) => fetch(input, init), getToken:()=>string = ()=>'') {
  let generation=0
  const responses=new WeakMap<Response, {version:number;token:string}>()
  const assertCurrent=(version: number,token: string)=>{if(version!==generation)throw new Error('Organization context changed');if(token!==getToken())throw new Error('Authentication context changed')}
  return {
    invalidate(){generation++},
    beforeSend(url: string,options: SendOptions){
      const version=generation,organization=getOrganization(),token=getToken()
      options.headers={...options.headers,...(organization?{'X-I7y-Organization':organization}:{})}
      options.fetch=async(input,init)=>{
        const response=await fetcher(input,init)
        assertCurrent(version,token)
        responses.set(response,{version,token})
        return response
      }
      return {url,options}
    },
    afterSend<T>(response: Response,data: T): T{const context=responses.get(response);assertCurrent(context.version,context.token);return data},
  }
}
