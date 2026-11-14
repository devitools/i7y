export function mcpPort(value:unknown):number|null{
  if(typeof value!=='string'&&typeof value!=='number')return null
  const text=String(value).trim()
  if(!/^\d+$/.test(text))return null
  const port=Number(text)
  return Number.isInteger(port)&&port>=1024&&port<=65535?port:null
}

export function mcpConnectionJson(connection:any,redact=false):string{
  if(!connection?.ready||!connection.url||!connection.authorization)return ''
  return JSON.stringify({transport:'streamable_http',url:connection.url,headers:{Authorization:redact?'Bearer <local-token>':connection.authorization}},null,2)
}
