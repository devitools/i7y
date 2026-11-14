import { connectedSources, incidentSourceClient } from './api'
import type { IncidentSource } from './incident-inbox'
export function incidentSources():IncidentSource[] {
  return connectedSources().map(source=>{
    const generation=source.generation,token=source.client.authStore.token
    return {id:source.id,name:source.name,generation,organizations:source.organizations.map(org=>({...org,role:source.globalAdmin?'admin':org.role})),send:async(path,query,organization)=>{
      const current=connectedSources().find(item=>item.id===source.id)
      if(!current || current.generation!==generation || current.client.authStore.token!==token)throw new Error('Connection session changed')
      if(organization)return incidentSourceClient(source.id,organization).send(path,{method:'GET',query})
      return source.client.send(path,{method:'GET',query,requestKey:null})
    }}
  })
}
