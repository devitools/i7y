export interface VaultReference { provider:string; account:string; vault:string; item:string }
export function vaultReference(value:unknown):VaultReference {
  const input=value&&typeof value==='object'?value as Record<string,unknown>:{}
  return Object.fromEntries(['provider','account','vault','item'].map(key=>[key,typeof input[key]==='string'?input[key].trim():key==='provider'?'1password':''])) as unknown as VaultReference
}
export function savedVaultReference(value:unknown):VaultReference|null {
  const reference=vaultReference(value)
  if(!reference.account&&!reference.vault&&!reference.item)return null
  if(reference.provider!=='1password'||!reference.vault||!reference.item||Object.values(reference).some(part=>part.length>240||part.startsWith('-')||/[\x00-\x1f]/.test(part)))throw new Error('vault.invalidReference')
  return reference
}
