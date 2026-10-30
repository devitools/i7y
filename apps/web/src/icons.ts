const aliases: Record<string,string> = {
  delete_outline:'delete',
  file_download:'download',
  cloud_queue:'cloud',
  help_outline:'help',
  people:'group',
  mail_outline:'mail',
  play_circle_outline:'play_circle',
}

const squarePen = [
  'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7',
  'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z',
].map(path => path+'@@fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round').join('&&')+'|0 0 24 24'

export function materialSymbol(name: string) {
  if(name==='edit' || name==='sym_o_edit')return {icon:squarePen}
  if(name.includes(':') || name.startsWith('sym_') || name.startsWith('mdi-'))return undefined
  return {icon:`sym_o_${aliases[name] || name}`}
}
