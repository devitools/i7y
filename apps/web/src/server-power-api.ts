import {pb} from './api'
const path=(server:string)=>'/api/i7y/server-power/v1/servers/'+encodeURIComponent(server)
export const serverPowerApi={
  get:(server:string)=>pb.send(path(server),{method:'GET',requestKey:null}),
  save:(server:string,body:unknown)=>pb.send(path(server),{method:'PUT',body,requestKey:null}),
  reconcile:(server:string,job:string)=>pb.send(path(server)+'/jobs/'+encodeURIComponent(job)+'/reconcile',{method:'POST',body:{inspected_console:true},requestKey:null}),
}
