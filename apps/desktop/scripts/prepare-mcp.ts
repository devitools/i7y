import {spawnSync} from 'node:child_process'
import {mkdirSync,copyFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
const release=process.argv.includes('--release')
const result=spawnSync('cargo',['build','--manifest-path',root+'mcp/Cargo.toml','--target-dir',root+'src-tauri/target',...(release?['--release']:[])],{stdio:'inherit'})
if(result.status!==0)process.exit(result.status||1)
const host=spawnSync('rustc',['-vV'],{encoding:'utf8'}).stdout.match(/^host: (.+)$/m)?.[1]
if(!host)throw new Error('Unable to determine connector target')
const suffix=process.platform==='win32'?'.exe':''
mkdirSync(root+'src-tauri/binaries',{recursive:true})
copyFileSync(root+`src-tauri/target/${release?'release':'debug'}/i7y-mcp${suffix}`,root+`src-tauri/binaries/i7y-mcp-${host}${suffix}`)
