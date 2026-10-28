import { ref, watch } from 'vue'
import { Dark } from 'quasar'

export const dark = ref(localStorage.getItem('i7y.dark') === 'true')
watch(dark, value => {
  Dark.set(value)
  localStorage.setItem('i7y.dark', String(value))
}, { immediate:true })
