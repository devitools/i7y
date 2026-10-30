export interface ListState {
  operatingSystem?: string
  search?: string
  matchingSearch?: string
  coverage?: string
  serverType?: string
  includeRemoved?: boolean
  onlyWithServers?: boolean
  descending?: boolean
  page?: number
  perPage?: number
  sortBy?: string
  statuses?: string[]
}
export interface RouteState extends ListState {
  organization?: string
  key?: string
  view?: string
  workspace?: string | null
  server?: string | null
  project?: string | string[] | null
  image?: string | string[] | null
  action?: string
  section?: string
  token?: string
  resource?: string
  id?: string | null
  ids?: string[]
  parent?: string | null
  returnTo?: string | null
  legacyOrder?: number
}
export interface WorkspaceChoice {
  id?: string
  login: string
  count?: number
  query?: string
}
export interface NavigationItem {
  id: string
  name: string
  icon: string
}
