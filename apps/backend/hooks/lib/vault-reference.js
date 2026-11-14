function invalid(){throw new Error('Invalid credential reference')}
function text(value,required=false){if(typeof value!=='string'||value!==value.trim()||value.length>240||value.startsWith('-')||/[\x00-\x1f]/.test(value)||(required&&!value))invalid();return value}
function manager(value){if(typeof value!=='string'||!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value))invalid();return value}
function normalize(value){
  if(value===null||value===undefined||value==='')return null
  if(typeof value!=='object'||Array.isArray(value))invalid()
  const canonical=Object.prototype.hasOwnProperty.call(value,'version')
  if(Object.keys(value).some(key=>!(canonical?['version','vault','account','item','options']:['provider','account','vault','item']).includes(key))||(canonical&&value.version!==2))invalid()
  const reference={version:2,vault:manager(canonical?value.vault:value.provider===undefined?'1password':value.provider),account:text(value.account===undefined?'':value.account),item:text(value.item,true)}
  const options=canonical?(value.options===undefined?{}:value.options):{vault:text(value.vault,true)}
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).length>8)invalid()
  const normalized={}
  for(const key of Object.keys(options).sort()){
    if(!/^[a-z][a-z0-9_]{0,63}$/.test(key)||/password|token|secret|credential|authorization|private|passphrase|otp|api_key/i.test(key))invalid()
    const part=text(options[key]);if(part)normalized[key]=part
  }
  if(reference.vault==='1password'&&Object.keys(normalized).some(key=>key!=='vault'))invalid()
  if(Object.keys(normalized).length)reference.options=normalized
  return reference
}
module.exports={normalize}
