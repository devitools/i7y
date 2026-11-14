import type { ConnectionPreferences, ConnectionProfile, Session } from './types';

export interface ConnectionStorage {
  read: (key: string) => Promise<string | null>;
  write: (key: string, value: string | null) => Promise<void>;
  secureRead: (key: string) => Promise<string | null>;
  secureWrite: (key: string, value: string | null) => Promise<void>;
}

export const connectionPreferencesKey = 'i7y.mobile.connections.v2';
export const connectionSessionKey = (id: string) => 'i7y.mobile.session.' + id;
export function parseStored<T>(value: string | null): T | null {
  try { return value ? JSON.parse(value) as T : null; } catch { return null; }
}

export async function migrateConnections(storage: ConnectionStorage, newId: () => string): Promise<ConnectionPreferences> {
  const existing = parseStored<ConnectionPreferences>(await storage.read(connectionPreferencesKey));
  if (existing?.version === 2 && Array.isArray(existing.profiles)) return existing;
  const preferences = parseStored<{ serverUrl: string; instanceId?: string; organizationId?: string }>(await storage.read('i7y.mobile.preferences'));
  const session = parseStored<Session>(await storage.secureRead('i7y.mobile.session'));
  const origin = session?.serverUrl || preferences?.serverUrl;
  const profiles: ConnectionProfile[] = origin ? [{
    id: session?.connectionId || newId(), name: new URL(origin).host, serverUrl: origin,
    instanceId: session?.instanceId || preferences?.instanceId || '', organizationId: preferences?.organizationId,
  }] : [];
  if (session && profiles[0]) await storage.secureWrite(connectionSessionKey(profiles[0].id), JSON.stringify(session));
  const value: ConnectionPreferences = { version: 2, activeId: profiles[0]?.id ?? null, profiles };
  await storage.write(connectionPreferencesKey, JSON.stringify(value));
  await storage.secureWrite('i7y.mobile.session', null);
  await storage.write('i7y.mobile.preferences', null);
  return value;
}
