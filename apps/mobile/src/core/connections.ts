import { ContextChangedError, I7yClient } from './client';
import type { ConnectionProfile, Organization, PushStatus, ServerInfo, Session, User } from './types';

export class MobileConnection {
  session: Session | null = null;
  info: ServerInfo | null = null;
  organizations: Organization[] = [];
  pushStatus: PushStatus = 'disabled';
  error = '';
  generation = 0;
  private clients = new Map<string, I7yClient>();
  private boundClients = new WeakMap<Session, Map<string, I7yClient>>();
  private boundRequests = new Set<I7yClient>();
  constructor(public profile: ConnectionProfile, private fetcher: typeof fetch, private changed: () => void = () => {}) {}
  get membershipRevision() {
    return JSON.stringify(this.organizations.map(org => [org.id, org.role]).sort((a, b) => a[0].localeCompare(b[0])));
  }
  replaceOrganizations(organizations: Organization[]) {
    this.organizations = organizations;
    this.changed();
  }
  api(organizationId: string | null = null) {
    const key = organizationId ?? '';
    let client = this.clients.get(key);
    if (!client) {
      client = new I7yClient(() => ({ serverUrl: this.profile.serverUrl, session: this.session, organizationId }), this.fetcher);
      this.clients.set(key, client);
    }
    return client;
  }
  boundApi(organizationId: string | null, session: Session, generation = this.generation) {
    const sessionCurrent = this.current(session, generation), membership = this.membershipRevision;
    const current = () => sessionCurrent() && this.membershipRevision === membership;
    if (!current()) throw new ContextChangedError();
    let clients = this.boundClients.get(session);
    if (!clients) { clients = new Map(); this.boundClients.set(session, clients); }
    const key = JSON.stringify([organizationId, membership]);
    let client = clients.get(key);
    if (!client) {
      const state = { serverUrl: session.serverUrl, session: { ...session, record: { ...session.record } }, organizationId };
      client = new I7yClient(() => state, this.fetcher, current);
      clients.set(key, client); this.boundRequests.add(client);
    }
    return client;
  }
  invalidate() {
    this.generation++;
    for (const client of [...this.clients.values(), ...this.boundRequests]) client.invalidate();
    this.boundClients = new WeakMap(); this.boundRequests.clear();
  }
  clear() { this.invalidate(); this.session = null; this.organizations = []; }
  current(session: Session, generation = this.generation) {
    const { token, connectionId, serverUrl, instanceId } = session;
    const userId = session.record.id;
    return () => this.session === session && this.generation === generation && session.token === token && session.connectionId === connectionId && session.serverUrl === serverUrl && session.instanceId === instanceId && session.record.id === userId;
  }
}

export class ConnectionRegistry {
  readonly connections = new Map<string, MobileConnection>();
  private selected: string | null = null;
  get activeId() { return this.selected; }
  select(id: string | null) { this.selected = id; }
}

export function connectionForSession(connections: Map<string, MobileConnection>, connectionId: string) {
  return [...connections.values()].find(connection => connection.session?.connectionId === connectionId) ?? null;
}

export function createLoginSession(profile: ConnectionProfile, token: string, record: User, newId: () => string): Session {
  return { token, record, connectionId: newId(), serverUrl: profile.serverUrl, instanceId: profile.instanceId };
}

export function sessionMatchesProfile(profile: ConnectionProfile, session: Session | null): session is Session {
  return !!session && session.serverUrl === profile.serverUrl && session.instanceId === profile.instanceId && typeof session.connectionId === 'string' && !!session.connectionId;
}

export function resolveIncidentSource(connections: Map<string, MobileConnection>, profileId: string, loginId: string, organizationId: string) {
  const connection = connections.get(profileId);
  const session = connection?.session;
  const organization = connection?.organizations.find(org => org.id === organizationId);
  if (!connection || !session || !loginId || session.connectionId !== loginId || !organization) return null;
  return { api: connection.boundApi(organizationId, session), session, organization, connection, generation: connection.generation };
}

export function sourceKey(connectionId: string, organizationId: string, incidentId = '') {
  return JSON.stringify([connectionId, organizationId, incidentId]);
}
