import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { quasar, transformAssetUrls } from '@quasar/vite-plugin'

const envDir = fileURLToPath(new URL('../..', import.meta.url))
export default defineConfig(({ command, mode }) => {
  const desktopBuild = mode === 'desktop'
  return {
    envDir,
    build: { manifest: true, rollupOptions: { input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), ...(desktopBuild ? { approval: fileURLToPath(new URL('./approval.html', import.meta.url)) } : { mobileAuth: fileURLToPath(new URL('./mobile-auth.html', import.meta.url)) }) } } },
    plugins: [vue({ template: { transformAssetUrls } }), quasar({ sassVariables: fileURLToPath(new URL('./src/css/quasar.variables.scss', import.meta.url)) })],
    define: desktopBuild ? { 'import.meta.env.VITE_POCKETBASE_URL': JSON.stringify('/') } : {},
    server: { proxy: { '/api': { target: process.env.I7Y_DEV_BACKEND || 'http://127.0.0.1:8097', changeOrigin: true, secure: true } } }
  }
})
