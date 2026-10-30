import type { QTableColumn } from 'quasar'

export function leadingRowActions(columns:QTableColumn[]):QTableColumn[] {
  const isAction=(column:QTableColumn)=>column.name==='action' || column.name==='actions'
  return [
    ...columns.filter(isAction).map(column=>({...column,align:'left' as const,style:'width:1%;white-space:nowrap',headerStyle:'width:1%'})),
    ...columns.filter(column=>!isAction(column)),
  ]
}
