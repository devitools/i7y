import test from 'node:test'
import assert from 'node:assert/strict'
import configure from '../apps/web/vite.config.ts'

test('desktop builds exclude installation URLs and browser development keeps its local proxy', () => {
  const previous = process.env.VITE_POCKETBASE_URL
  process.env.VITE_POCKETBASE_URL = 'https://inventory.example.com'
  try {
    const desktop = configure({ command: 'serve', mode: 'desktop' })
    assert.equal(desktop.define['import.meta.env.VITE_POCKETBASE_URL'], '"/"')
    assert.equal(desktop.server.proxy['/api'].target, 'http://127.0.0.1:8097')
    assert.equal(desktop.server.proxy['/api'].secure, true)
    assert.equal(desktop.server.proxy['/api'].changeOrigin, true)
    const packaged = configure({ command: 'build', mode: 'desktop' })
    assert.equal(packaged.define['import.meta.env.VITE_POCKETBASE_URL'], '"/"')
    const browser = configure({ command: 'serve', mode: 'development' })
    assert.equal(browser.server.proxy['/api'].target, 'http://127.0.0.1:8097')
  } finally {
    if (previous === undefined) delete process.env.VITE_POCKETBASE_URL
    else process.env.VITE_POCKETBASE_URL = previous
  }
})
