import { createApp } from 'vue'
import { Quasar, Notify, Dialog } from 'quasar'
import en from 'quasar/lang/en-US'
import '@quasar/extras/material-symbols-outlined/material-symbols-outlined.css'
import iconSet from 'quasar/icon-set/material-symbols-outlined'
import './css/app.scss'
import 'quasar/src/css/index.sass'
import './style.css'
import MobileAuthorizationApp from './components/MobileAuthorizationApp.vue'
import { dark } from './theme'

Quasar.iconSet.iconMapFn = name => name.includes(':') || name.startsWith('sym_') || name.startsWith('mdi-') ? undefined : {icon:`sym_o_${name}`}
createApp(MobileAuthorizationApp).use(Quasar, { plugins: { Notify, Dialog }, lang: en, iconSet, config: { dark: dark.value, brand: { primary: '#4f46e5', secondary: '#64748b', positive: '#22c55e' } } }).mount('#app')
