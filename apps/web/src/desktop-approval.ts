import {createApp} from 'vue'
import {Quasar} from 'quasar'
import en from 'quasar/lang/en-US'
import iconSet from 'quasar/icon-set/material-symbols-outlined'
import '@quasar/extras/material-symbols-outlined/material-symbols-outlined.css'
import './css/app.scss'
import 'quasar/src/css/index.sass'
import './style.css'
import {materialSymbol} from './icons'
import {dark} from './theme'
import DesktopApproval from './components/DesktopApproval.vue'
Quasar.iconSet.iconMapFn=materialSymbol
createApp(DesktopApproval).use(Quasar,{lang:en,iconSet,config:{dark:dark.value,brand:{primary:'#4f46e5',positive:'#247a4b'}}}).mount('#app')
