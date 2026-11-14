function normalize(value){
  if(value===null||value===undefined||value==='')return null
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['provider','account','vault','item'].includes(key)))throw new Error('Invalid credential reference')
  const reference={provider:value.provider===undefined?'1password':value.provider,account:value.account===undefined?'':value.account,vault:value.vault,item:value.item}
  if(reference.provider!=='1password'||!reference.vault||!reference.item||Object.values(reference).some(part=>typeof part!=='string'||part!==part.trim()||part.length>240||part.startsWith('-')||/[\x00-\x1f]/.test(part)))throw new Error('Invalid credential reference')
  return reference
}
module.exports={normalize}
