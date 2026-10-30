import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
const signingFile = new URL('../../../.local/desktop-signing.json', import.meta.url)
const environment = { ...process.env }
if (process.platform === 'darwin' && !environment.APPLE_SIGNING_IDENTITY && existsSync(signingFile)) {
  const signing = JSON.parse(readFileSync(signingFile, 'utf8'))
  if (typeof signing.identity !== 'string' || !signing.identity.trim() || signing.identity === '-') throw new Error('Invalid local macOS signing identity')
  environment.APPLE_SIGNING_IDENTITY = signing.identity
}
const csp = config.app.security.csp
const override = { app: { security: { csp, devCsp: csp + ' ws://127.0.0.1:5178' } } }
const require = createRequire(import.meta.url)
const cli = require.resolve('@tauri-apps/cli/tauri.js')
const prepare = spawn(process.execPath, ['--import','tsx',fileURLToPath(new URL('./prepare-mcp.ts',import.meta.url)),...(process.argv.includes('build')&&!process.argv.includes('--debug')?['--release']:[])], {cwd:desktop,stdio:'inherit'})
const prepared=await new Promise<number>(resolve=>{prepare.on('exit',code=>resolve(code??1));prepare.on('error',()=>resolve(1))})
if(prepared!==0)process.exit(prepared)
const child = spawn(process.execPath, [cli, ...process.argv.slice(2), '--config', JSON.stringify(override)], { cwd: desktop, stdio: 'inherit', env: environment })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
