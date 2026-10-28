import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { quasar, transformAssetUrls } from '@quasar/vite-plugin'
export default defineConfig({ plugins: [vue({ template: { transformAssetUrls } }), quasar({sassVariables:fileURLToPath(new URL('./src/css/quasar.variables.scss',import.meta.url))})], server: { proxy: { '/api': 'http://127.0.0.1:8097' } } })
