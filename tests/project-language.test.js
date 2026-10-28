import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const extensions = new Set(['.ts', '.js', '.vue', '.go', '.py', '.md', '.json', '.sh', '.yaml', '.ps1', '.css', '.scss', '.html'])
const ignored = new Set(['node_modules', 'dist', 'target', '__pycache__', 'locales'])
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name)) return []
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : extensions.has(extname(path)) ? [path] : []
  })
}

test('source and canonical documentation keep localized Latin text inside locale resources', () => {
  const files = ['apps', 'docs', 'scripts', 'deploy', 'tests'].flatMap(name => sourceFiles(resolve(root, name)))
  files.push(resolve(root, 'README.md'), resolve(root, 'THIRD_PARTY.md'))
  for (const path of files) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /[\u00c0-\u00ff]/u, relative(root, path))
  }
})
