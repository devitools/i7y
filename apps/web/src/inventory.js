export function flatten(workspaces) {
  const services = workspaces.flatMap(account => account.services.map((service, index) => ({ ...service, account: account.login, query: account.query, provider: account.provider, key: `${account.login}:${service.ip || service.name || service.product}:${index}` })))
  const servers = services.filter(service => service.type === 'VPS')
  const projects = servers.flatMap(server => (server.projects || []).map((project, index) => ({ ...project, server, key: `${server.key}:${index}` })))
  const containers = projects.flatMap(project => project.containers.map(container => ({ ...container, project: project.name, projectKey: project.key, path: project.path, server: project.server, key: `${project.server.key}:${container.name}` })))
  return { services, servers, projects, containers }
}
export function matches(value, query) {
  const term = (query || '').trim().toLocaleLowerCase()
  return !term || JSON.stringify(value).toLocaleLowerCase().includes(term)
}
export function hasInventory(server) { return Array.isArray(server.projects) }

export function containersUsingImage(containers, image) { return containers.filter(container => container.image === image) }

export function groupImages(containers) {
  const groups = new Map()
  for (const container of containers) {
    const image = container.image
    const group = groups.get(image) || {key:image,name:image,count:0}
    group.count += 1
    groups.set(image,group)
  }
  return [...groups.values()].sort((a,b) => b.count-a.count || a.name.localeCompare(b.name))
}
