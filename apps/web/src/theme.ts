import { ref, watch } from 'vue'
import { Dark } from 'quasar'
import { syncDesktopTheme } from './desktop'

export const dark = ref(localStorage.getItem('i7y.dark') === 'true')
watch(dark, value => {
  Dark.set(value)
  void syncDesktopTheme(value).catch(error => console.error('Unable to synchronize the desktop theme', error))
  localStorage.setItem('i7y.dark', String(value))
}, { immediate:true })
