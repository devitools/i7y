export const containerStatusOptions = [
  {value:'running',label:'Running'},
  {value:'exited',label:'Stopped'},
  {value:'paused',label:'Paused'},
  {value:'restarting',label:'Restarting'},
  {value:'created',label:'Created'},
  {value:'dead',label:'Dead'},
  {value:'removing',label:'Removing'},
  {value:'missing',label:'Removed'},
  {value:'unknown',label:'Unknown'}
]
export function normalizeStatuses(values) {
  return [...new Set(values.filter(value=>containerStatusOptions.some(option=>option.value===value)))]
}
