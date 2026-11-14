import type { MobileConnection } from './connections';
import { connectionForSession } from './connections';
import type { IncidentNotification } from './types';

export function parseIncidentNotification(data: Record<string, unknown> | undefined): IncidentNotification | null {
  if (!data) return null;
  const keys = ['connection_id', 'organization_id', 'incident_id', 'event_id'] as const;
  if (!keys.every(key => typeof data[key] === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(data[key] as string))) return null;
  return Object.fromEntries(keys.map(key => [key, data[key]])) as unknown as IncidentNotification;
}

export function allowsNotification(data: IncidentNotification | null, connections: Map<string, MobileConnection>) {
  const connection = data && connectionForSession(connections, data.connection_id);
  return !!data && !!connection?.session && connection.organizations.some(org => org.id === data.organization_id);
}

export async function routeIncidentNotification(data: IncidentNotification, connections: Map<string, MobileConnection>, refresh: (connection: MobileConnection) => Promise<void>) {
  const connection = connectionForSession(connections, data.connection_id);
  if (!connection?.session) return null;
  const session = connection.session, current = connection.current(session);
  await refresh(connection);
  if (!current() || !allowsNotification(data, connections)) return null;
  await connection.boundApi(data.organization_id, session).incident(data.incident_id);
  if (!current() || connections.get(connection.profile.id) !== connection) return null;
  return { id: data.incident_id, connectionId: connection.profile.id, loginId: session.connectionId, organizationId: data.organization_id };
}
