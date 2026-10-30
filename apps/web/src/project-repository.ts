export interface ProjectRepository {
  source_repository_url?: string
  deployment_branch?: string
  deployment_template?: string
  version_control_status?: string
}

export function repositoryHref(value?: string): string {
  if (!value || value.includes('\\') || !/^https?:\/\/[^/@\s?#]+(\/[^\s?#]*)?$/.test(value)) return ''
  try {
    const url = new URL(value)
    return url.hostname && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}

export function repositoryLabel(value?: string): string {
  const href = repositoryHref(value)
  return href ? new URL(href).host + new URL(href).pathname.replace(/\/$/,'') : ''
}

export function versionControlLabel(value?: string): string {
  return value === 'versioned' ? 'Versioned' : value === 'unversioned' ? 'Not versioned' : 'To confirm'
}
