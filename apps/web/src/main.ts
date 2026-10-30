import { createApp } from 'vue'
import { Quasar, Notify, Dialog } from 'quasar'
import en from 'quasar/lang/en-US'
import '@quasar/extras/material-symbols-outlined/material-symbols-outlined.css'
import iconSet from 'quasar/icon-set/material-symbols-outlined'
import './css/app.scss'
import 'quasar/src/css/index.sass'
import './style.css'
import App from './App.vue'
import { materialSymbol } from './icons'
import { initializeDesktopBackend } from './api'
import { desktopBackendError } from './desktop-backend'
import { dark } from './theme'
Quasar.iconSet.iconMapFn = materialSymbol
async function start() {
  try {await initializeDesktopBackend()} catch {desktopBackendError.value=true}
  createApp(App).use(Quasar, { plugins: { Notify, Dialog }, lang: en, iconSet, config: { dark: dark.value, brand: { primary: '#4f46e5', secondary: '#64748b', positive: '#247a4b' } } }).mount('#app')
}
void start()
