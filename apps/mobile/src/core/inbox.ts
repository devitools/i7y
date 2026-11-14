import { ApiError, ContextChangedError, incidentTimestamp } from './client';
import type { I7yClient } from './client';
import type { MobileConnection } from './connections';
import { sourceKey } from './connections';
import type { Incident, Page, Session, SourcedIncident } from './types';

interface Source { key: string; connectionId: string; loginId: string; session: Session; generation: number; membershipRevision: string; current: () => boolean; organizationId: string; api: I7yClient; inbox: boolean; connection: MobileConnection }
interface Buffer { source: Source; page: number; items: SourcedIncident[]; done: boolean; total: number; error?: boolean }
export interface InboxCursor { buffers: Buffer[]; seen: string[]; page: number }
export interface InboxPage { items: SourcedIncident[]; totalItems: number; failures: string[]; next?: InboxCursor }

export function compareIncidents(a: Incident, b: Incident) {
  for (const field of ['opened_at', 'created'] as const) {
    const delta = (incidentTimestamp(b[field] ?? '') || 0) - (incidentTimestamp(a[field] ?? '') || 0);
    if (delta) return delta;
  }
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}
export function incidentIdentity(incident: SourcedIncident) { return JSON.stringify([incident.connectionId, incident.loginId, incident.organizationId, incident.id]); }
function sourceSnapshot(connection: MobileConnection): Source {
  const session = connection.session!;
  const generation = connection.generation;
  return { key: sourceKey(connection.profile.id, session.connectionId), connectionId: connection.profile.id, loginId: session.connectionId, session, generation, membershipRevision: connection.membershipRevision, current: connection.current(session, generation), organizationId: '', api: connection.boundApi(null, session, generation), inbox: true, connection };
}
function fallbackSources(source: Source): Source[] {
  if (!source.current()) throw new ContextChangedError();
  return source.connection.organizations.map(org => ({ ...source, key: sourceKey(source.connectionId, source.loginId, org.id), organizationId: org.id, api: source.connection.boundApi(org.id, source.session, source.generation), inbox: false }));
}
export function inboxCursor(connections: MobileConnection[]): InboxCursor {
  return { buffers: connections.filter(c => c.session).map(connection => ({ source: sourceSnapshot(connection), page: 1, items: [], done: false, total: 0 })), seen: [], page: 1 };
}

export async function loadInboxPage(cursor: InboxCursor, filters: Record<string, unknown>, size = 30): Promise<InboxPage> {
  const buffers: Buffer[] = cursor.buffers.map(value => ({ ...value, items: [...value.items], error: false }));
  const assertCurrent = () => { if (buffers.some(buffer => !buffer.source.current() || buffer.source.membershipRevision !== buffer.source.connection.membershipRevision)) throw new ContextChangedError(); };
  assertCurrent();
  const seen = new Set(cursor.seen);
  const failures = new Set<string>();
  async function fill(buffer: Buffer): Promise<void> {
    if (!buffer.source.current()) throw new ContextChangedError();
    if (buffer.done || buffer.items.length || buffer.error) return;
    const { session, current } = buffer.source;
    try {
      if (!session) throw new ContextChangedError();
      const query = { ...filters, page: buffer.page, perPage: size };
      let result: Page<Incident>;
      try { result = buffer.source.inbox ? await buffer.source.api.inbox(query) : await buffer.source.api.incidents(query); }
      catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 404 || !buffer.source.inbox) throw cause;
        const replacements = fallbackSources(buffer.source).map(source => ({ source, page: 1, items: [], done: false, total: 0 }));
        buffer.done = true;
        buffers.push(...replacements);
        await Promise.all(replacements.map(fill));
        return;
      }
      if (!current?.()) throw new ContextChangedError();
      if (buffer.source.inbox && result.items.some(item => {
        const id = item.organization_id || item.organization;
        return id && !buffer.source.connection.organizations.some(org => org.id === id);
      })) {
        try {
          const memberships = await buffer.source.api.organizations();
          if (!current()) throw new ContextChangedError();
          if (!Array.isArray(memberships.items)) throw new Error('Membership response unavailable');
          buffer.source.connection.replaceOrganizations(memberships.items);
        } catch (cause) { if (cause instanceof ContextChangedError || !current()) throw new ContextChangedError(); }
      }
      assertCurrent();
      buffer.items = result.items.flatMap(item => {
        const organizationId = item.organization_id || item.organization || buffer.source.organizationId;
        if (!organizationId || !buffer.source.connection.organizations.some(org => org.id === organizationId)) return [];
        return [{ ...item, connectionId: buffer.source.connectionId, loginId: buffer.source.loginId, organizationId, connectionName: buffer.source.connection.profile.name, userId: session.record.id }];
      }).sort(compareIncidents);
      buffer.total = result.totalItems;
      buffer.page++;
      buffer.done = result.page >= result.totalPages || result.items.length === 0;
    } catch (cause) {
      if (cause instanceof ContextChangedError || !current()) throw new ContextChangedError();
      buffer.error = true;
      failures.add(buffer.source.connectionId);
    }
  }
  const items: SourcedIncident[] = [];
  while (items.length < size) {
    await Promise.all(buffers.map(fill));
    assertCurrent();
    const candidates = buffers.filter(buffer => buffer.items.length);
    if (!candidates.length) break;
    candidates.sort((a, b) => compareIncidents(a.items[0], b.items[0]) || a.source.key.localeCompare(b.source.key));
    const item = candidates[0].items.shift()!;
    const identity = incidentIdentity(item);
    if (!seen.has(identity)) { seen.add(identity); items.push(item); }
  }
  assertCurrent();
  const remaining = buffers.some(buffer => buffer.items.length || (!buffer.done && !buffer.error));
  return { items, totalItems: buffers.reduce((total, buffer) => total + buffer.total, 0), failures: [...failures], next: remaining ? { buffers, seen: [...seen], page: cursor.page + 1 } : undefined };
}
