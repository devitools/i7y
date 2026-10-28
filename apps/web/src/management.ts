import type { ListOptions } from 'pocketbase'
const resources = new Set(['workspaces', 'servers', 'projects', 'containers'])

export function createManagementApi(client) {
  const collection = resource => {
    if (!resources.has(resource)) throw new TypeError(`Recurso inválido: ${resource}`)
    return client.collection(resource)
  }
  return {
    signIn: (email, password) => client.collection('users').authWithPassword(email, password),
    refreshSession: () => client.collection('users').authRefresh(),
    signOut: () => client.authStore.clear(),
    list: (resource, options: ListOptions = {}) => collection(resource).getList(options.page || 1, options.perPage || 50, options),
    listAll: (resource, options: ListOptions = {}) => collection(resource).getFullList({...options, requestKey:null}),
    get: (resource, id, options: ListOptions = {}) => collection(resource).getOne(id, options),
    create: (resource, values) => collection(resource).create(values),
    update: (resource, id, values) => collection(resource).update(id, values),
    remove: (resource, id) => collection(resource).delete(id),
  }
}
