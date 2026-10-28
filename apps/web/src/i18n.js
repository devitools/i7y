import { ref, watch } from 'vue'
import { messages } from './messages'
export const languageOptions = [{label:'EN',value:'en'},{label:'PT',value:'pt-BR'},{label:'UK',value:'uk'}]
const savedLocale = localStorage.getItem('i7y.locale')
export const locale = ref(languageOptions.some(option=>option.value===savedLocale) ? savedLocale : 'en')
export function t(key) { return messages[locale.value]?.[key] || messages.en[key] || key }
watch(locale, value => {
  localStorage.setItem('i7y.locale', value)
  document.documentElement.lang = value
  document.title = value === 'en' ? 'i7y' : 'i7y'
}, { immediate: true })
