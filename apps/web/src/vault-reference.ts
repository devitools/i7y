export interface CredentialReference { version:2; vault:string; account:string; item:string; options?:Record<string,string> }
export const credentialManagers=[{label:'1Password',value:'1password'}]
function invalid():never {throw new Error('vault.invalidReference')}
function text(value:unknown,required=false):string {
  if(typeof value!=='string'||value!==value.trim()||value.length>240||value.startsWith('-')||/[\x00-\x1f]/.test(value)||required&&!value)invalid()
  return value
}
export function savedCredentialReference(value:unknown):CredentialReference|null {
  if(value===null||value===undefined||value==='')return null
  if(typeof value!=='object'||Array.isArray(value))invalid()
  const input=value as Record<string,unknown>,canonical=Object.hasOwn(input,'version')
  const fields=canonical?['version','vault','account','item','options']:['provider','account','vault','item']
  if(Object.keys(input).some(key=>!fields.includes(key))||canonical&&input.version!==2)invalid()
  const manager=canonical?input.vault:input.provider===undefined?'1password':input.provider
  if(typeof manager!=='string'||!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(manager))invalid()
  const reference:CredentialReference={version:2,vault:manager,account:text(input.account===undefined?'':input.account),item:text(input.item,true)}
  const options=canonical?(input.options===undefined?{}:input.options):{vault:text(input.vault,true)}
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).length>8)invalid()
  const normalized:Record<string,string>={}
  for(const key of Object.keys(options).sort()){
    if(!/^[a-z][a-z0-9_]{0,63}$/.test(key)||/password|token|secret|credential|authorization|private|passphrase|otp|api_key/i.test(key))invalid()
    const part=text(options[key]);if(part)normalized[key]=part
  }
  if(manager==='1password'&&Object.keys(normalized).some(key=>key!=='vault'))invalid()
  if(Object.keys(normalized).length)reference.options=normalized
  return reference
}
export function credentialReference(value:unknown):CredentialReference {
  return savedCredentialReference(value)||{version:2,vault:'1password',account:'',item:''}
}
export function credentialManagerLabel(value:unknown):string {
  const manager=credentialReference(value).vault
  return credentialManagers.find(option=>option.value===manager)?.label||manager
}
