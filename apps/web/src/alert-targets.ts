type RecordData = Record<string, any>
export type AlertScope = 'workspace' | 'server' | 'container'
export type TargetFilters = {workspace: string, server: string, project: string, type: string, os: string, provider: string}
export const emptyTargetFilters = (): TargetFilters => ({workspace: '', server: '', project: '', type: '', os: '', provider: ''})
const label = (row?: RecordData) => row?.name || row?.login || row?.hostname || row?.id || ''
const normalize = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

export function alertTargetChoices(inventory: Record<string, RecordData[]>, scope: AlertScope) {
  const workspaces = new Map(inventory.workspace.map(row => [row.id, row]))
  const servers = new Map(inventory.server.map(row => [row.id, row]))
  const projects = new Map((inventory.project || []).map(row => [row.id, row]))
  const choices = inventory[scope].map(row => {
    const project = scope === 'container' ? projects.get(row.project) : undefined
    const server = scope === 'server' ? row : servers.get(project?.server)
    const workspace = scope === 'workspace' ? row : workspaces.get(server?.workspace)
    const system = server?.telemetry?.host?.operating_system
    const os = system?.pretty_name || [system?.name, system?.version_id].filter(Boolean).join(' ')
    const description = (scope === 'workspace' ? [row.provider] : scope === 'server' ? [label(workspace), row.ip, os] : [label(workspace), label(server), server?.ip, label(project), row.image]).filter(Boolean).join(' · ')
    return {
      value: row.id as string, label: label(row), description,
      workspace: workspace?.id || '', server: server?.id || '', project: project?.id || '',
      type: server?.type || '', os, provider: workspace?.provider || '',
      search: normalize([label(row), row.id, description, label(workspace), server?.ip, server?.product, row.image].filter(Boolean).join(' ')),
    }
  }).sort((left, right) => left.label.localeCompare(right.label) || left.description.localeCompare(right.description) || left.value.localeCompare(right.value))
  const duplicates = new Map<string, number>()
  for (const choice of choices) {
    const identity = choice.label + '\0' + choice.description
    duplicates.set(identity, (duplicates.get(identity) || 0) + 1)
  }
  for (const choice of choices) if (duplicates.get(choice.label + '\0' + choice.description)! > 1) choice.description = [choice.description, choice.value].filter(Boolean).join(' · ')
  return choices
}

export function filterAlertTargets(choices: ReturnType<typeof alertTargetChoices>, filters: TargetFilters, query = '') {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean)
  return choices.filter(choice => Object.entries(filters).every(([field, value]) => !value || choice[field] === value) && terms.every(term => choice.search.includes(term)))
}
