import { createContext, useContext, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { AppState, Platform } from 'react-native';
import { fetch } from 'expo/fetch';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useQueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import NetInfo from '@react-native-community/netinfo';
import { ApiError, AuthorizationCancelledError, ContextChangedError, normalizeServerUrl } from '@/core/client';
import { ConnectionRegistry, MobileConnection, connectionForSession, createLoginSession, sessionMatchesProfile, resolveIncidentSource, sourceKey } from '@/core/connections';
import { useLocale } from '@/locales';
import { allowsNotification, routeIncidentNotification } from '@/core/notification-router';
import { registrationProof } from '@/core/push-proof';
import { allowLocalServers } from '@/core/config';
import type { I7yClient } from '@/core/client';
import type { ConnectionProfile, Organization, PushStatus, ServerInfo, Session, User } from '@/core/types';
import { loadConnections, loadPush, loadPushProof, loadPushStore, loadSession, prepareStorage, saveConnections, saveSession } from '@/core/storage';
import { configuredGateway, enrollPush, parseIncidentNotification, revokePush, resumePushRegistration, recordPushDiagnostic, syncPushLocale } from '@/core/push';

const redirectUrl = 'com.devitools.i7y.mobile://auth/callback';
type Source = { api: I7yClient; session: Session; organization: Organization; connection: MobileConnection; queryKey: readonly unknown[] };
type AppSession = {
  ready: boolean; serverUrl: string; info: ServerInfo | null; session: Session | null; hasSessions: boolean;
  organizations: Organization[]; organizationId: string | null; organization: Organization | null;
  api: I7yClient; queryKey: readonly unknown[]; feedKey: readonly unknown[]; busy: boolean; error: string; authCode: string; pushStatus: PushStatus;
  connections: MobileConnection[]; activeId: string | null; getSource: (connectionId: string, loginId: string, organizationId: string) => Source | null;
  connect: (url: string) => Promise<void>; signIn: (url?: string) => Promise<void>; signOut: () => Promise<void>;
  disconnect: () => Promise<void>; setOrganization: (id: string) => void; selectConnection: (id: string) => void;
  renameConnection: (id: string, name: string) => Promise<void>; removeConnection: (id: string) => Promise<void>;
  registerPush: () => Promise<void>; disablePush: () => Promise<void>;
};
const Context = createContext<AppSession | null>(null);
const secret = () => Array.from(Crypto.getRandomBytes(32), n => n.toString(16).padStart(2, '0')).join('');
function userRecord(record: User): User { return { id: record.id, email: record.email, name: record.name, global_admin: record.global_admin }; }

export function SessionProvider({ children }: PropsWithChildren) {
  const language = useLocale();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [registry] = useState(() => new ConnectionRegistry());
  const [, setRevision] = useState(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authCode, setAuthCode] = useState('');
  const operationBusy = useRef(false);
  const mounted = useRef(true);
  const restoring = useRef(false);
  const pushBusy = useRef(new Set<string>());
  const notificationIds = useRef(new Set<string>());
  const [empty] = useState(() => new MobileConnection({ id: '', name: '', serverUrl: '', instanceId: '' }, fetch as typeof globalThis.fetch));
  function update() { if (mounted.current) setRevision(value => value + 1); }
  function persist() { return saveConnections({ version: 2, activeId: registry.activeId, profiles: [...registry.connections.values()].map(c => ({ ...c.profile })) }); }
  function currentConnection() { return registry.connections.get(registry.activeId ?? '') ?? null; }
  function cacheKey(connection: MobileConnection) { return ['connection', connection.profile.id, connection.profile.serverUrl, connection.profile.instanceId, connection.generation, connection.membershipRevision, connection.session?.connectionId, connection.session?.record.id] as const; }
  function clearCache(connection: MobileConnection) {
    queryClient.removeQueries({ queryKey: ['connection', connection.profile.id] });
    queryClient.removeQueries({ queryKey: ['inbox'] });
  }
  async function run(action: () => Promise<void>) {
    if (operationBusy.current) return;
    operationBusy.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (cause) { if (mounted.current && !(cause instanceof AuthorizationCancelledError)) setError(cause instanceof Error ? cause.message : 'Unable to complete this action'); throw cause; }
    finally { operationBusy.current = false; if (mounted.current) { setBusy(false); setAuthCode(''); } }
  }
  async function loadOrganizations(connection: MobileConnection) {
    const session = connection.session;
    const current = session && connection.current(session);
    const result = await connection.api().organizations();
    if (!current?.()) throw new ContextChangedError();
    connection.organizations = result.items;
    if (!result.items.some(org => org.id === connection.profile.organizationId)) connection.profile = { ...connection.profile, organizationId: result.items[0]?.id };
    update(); await persist();
  }
  async function disableConnectionPush(connection: MobileConnection, session = connection.session) {
    if (!session) return;
    const saved = await loadPush(session.connectionId);
    const revoked = await revokePush(session.connectionId);
    connection.pushStatus = revoked ? 'disabled' : 'pending-revocation'; update();
    if (saved?.backendDeviceId && session) {
      const old = new MobileConnection(connection.profile, fetch as typeof globalThis.fetch);
      old.session = session;
      try { await old.api().request('/api/i7y/mobile/v1/devices/' + encodeURIComponent(saved.backendDeviceId), { method: 'DELETE' }); } catch {}
    }
  }
  async function retryPushRemovals() {
    const store = await loadPushStore();
    for (const binding of Object.values(store.bindings)) {
      if (!binding.pendingRevocation) continue;
      const removed = await revokePush(binding.connectionId);
      const connection = connectionForSession(registry.connections, binding.connectionId);
      if (connection) connection.pushStatus = removed ? 'disabled' : 'pending-revocation';
    }
    update();
  }
  async function signOutConnection(connection: MobileConnection) {
    const previous = connection.session;
    connection.clear(); clearCache(connection); update();
    await Promise.all([saveSession(connection.profile.id, null), disableConnectionPush(connection, previous)]);
  }
  async function signOut() { const connection = currentConnection(); if (connection) await signOutConnection(connection); }
  async function removeConnection(id: string) {
    const connection = registry.connections.get(id);
    if (!connection) return;
    await signOutConnection(connection);
    registry.connections.delete(id);
    if (registry.activeId === id) registry.select([...registry.connections.keys()][0] ?? null);
    update(); await persist();
  }
  async function disconnect() { if (registry.activeId) await removeConnection(registry.activeId); }
  function selectConnection(id: string) {
    if (!registry.connections.has(id)) return;
    registry.select(id); setError(''); update(); void persist().catch(() => setError('Unable to save connection preference'));
  }
  async function renameConnection(id: string, name: string) {
    const connection = registry.connections.get(id);
    if (!connection || !name.trim()) return;
    connection.profile = { ...connection.profile, name: name.trim().slice(0, 80) }; update(); await persist();
  }
  async function verify(input: string) {
    const origin = normalizeServerUrl(input, allowLocalServers);
    const verified = await empty.api().info(origin);
    let connection = [...registry.connections.values()].find(c => c.profile.serverUrl === origin && c.profile.instanceId === verified.instance_id);
    if (!connection) {
      const profile: ConnectionProfile = { id: Crypto.randomUUID(), name: new URL(origin).host, serverUrl: origin, instanceId: verified.instance_id };
      connection = new MobileConnection(profile, fetch as typeof globalThis.fetch, update);
      registry.connections.set(profile.id, connection);
    }
    connection.info = verified;
    registry.select(connection.profile.id);
    update(); await persist();
    return connection;
  }
  async function connect(input: string) { await run(async () => { await verify(input); }); }
  async function registerConnectionPush(connection: MobileConnection) {
    if (pushBusy.current.has(connection.profile.id) || !connection.session || !connection.info) return;
    const session = connection.session;
    const current = connection.current(session);
    pushBusy.current.add(connection.profile.id); connection.pushStatus = 'registering'; update();
    try {
      const result = await enrollPush(connection.api(), connection.info, session, current);
      if (current()) { connection.pushStatus = result; update(); }
    } catch (cause) {
      if (current()) { connection.pushStatus = (await loadPush(session.connectionId))?.pendingRevocation ? 'pending-revocation' : 'unavailable'; update(); }
      throw cause;
    } finally { pushBusy.current.delete(connection.profile.id); }
  }
  async function signIn(input?: string) {
    await run(async () => {
      const connection = await verify(input ?? currentConnection()?.profile.serverUrl ?? '');
      const generation = connection.generation;
      const origin = connection.profile.serverUrl;
      const verified = connection.info!;
      const request = secret(), verifier = secret();
      const challenge = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier);
      setAuthCode(request.slice(0, 8).toUpperCase());
      const query = new URLSearchParams({ request, challenge, instance_id: verified.instance_id });
      const result = await WebBrowser.openAuthSessionAsync(origin + '/mobile-auth.html#/mobile-authorize?' + query.toString(), redirectUrl);
      if (generation !== connection.generation || !registry.connections.has(connection.profile.id)) throw new ContextChangedError();
      if (result.type !== 'success') throw new AuthorizationCancelledError();
      const callback = new URL(result.url);
      if (callback.origin !== 'null' || callback.protocol !== 'com.devitools.i7y.mobile:' || callback.hostname !== 'auth' || callback.pathname !== '/callback' || callback.searchParams.get('request') !== request) throw new Error('Invalid authorization callback');
      const response = await connection.api().request<{ token?: string; record?: User; pending?: boolean; meta?: { instance_id: string } }>('/api/i7y/mobile/v1/auth/exchange', { method: 'POST', public: true, body: { request, verifier, instance_id: verified.instance_id } });
      if (!response.token || !response.record || response.meta?.instance_id !== verified.instance_id) throw new Error('The server could not complete mobile authorization');
      if (generation !== connection.generation) throw new ContextChangedError();
      const session = createLoginSession(connection.profile, response.token, userRecord(response.record), () => Crypto.randomUUID());
      if (connection.session) await signOutConnection(connection);
      connection.invalidate(); clearCache(connection); connection.session = session;
      const current = connection.current(session);
      await saveSession(connection.profile.id, session, current);
      if (!current()) throw new ContextChangedError();
      update();
      await loadOrganizations(connection);
      const store = await loadPushStore();
      if (Object.keys(store.devices).length && current()) await registerConnectionPush(connection).catch(() => {});
      router.replace('/(tabs)');
    });
  }
  function setOrganization(id: string) {
    const connection = currentConnection();
    if (!connection?.organizations.some(org => org.id === id)) return;
    connection.profile = { ...connection.profile, organizationId: id }; update(); void persist().catch(() => {});
  }
  function getSource(connectionId: string, loginId: string, organizationId: string): Source | null {
    const source = resolveIncidentSource(registry.connections, connectionId, loginId, organizationId);
    return source ? { ...source, queryKey: [...cacheKey(source.connection), loginId, organizationId] } : null;
  }
  async function restoreConnection(connection: MobileConnection) {
    const generation = connection.generation;
    const saved = await loadSession(connection.profile.id);
    if (generation !== connection.generation) return;
    if (sessionMatchesProfile(connection.profile, saved)) connection.session = saved;
    update();
    try {
      const info = await connection.api().info();
      if (generation !== connection.generation) return;
      connection.info = info;
      if (saved && saved.instanceId !== info.instance_id) { await signOutConnection(connection); return; }
      if (connection.session) {
        const session = connection.session, current = connection.current(session);
        const refreshed = await connection.api().request<{ token: string; record: User }>('/api/collections/users/auth-refresh', { method: 'POST' });
        if (!current()) return;
        connection.session = { ...session, token: refreshed.token, record: userRecord(refreshed.record) };
        await saveSession(connection.profile.id, connection.session, connection.current(connection.session));
        await loadOrganizations(connection);
      }
      const push = connection.session ? await loadPush(connection.session.connectionId) : null;
      connection.pushStatus = push?.pendingRevocation ? await revokePush(push.connectionId) ? 'disabled' : 'pending-revocation' : push ? 'enabled' : configuredGateway(info) ? 'disabled' : 'unconfigured';
      connection.error = '';
    } catch (cause) {
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) await signOutConnection(connection);
      else connection.error = 'Unable to refresh connection';
    }
    update();
  }
  const restore = useEffectEvent(async () => {
    if (restoring.current) return;
    restoring.current = true;
    try {
      await prepareStorage();
      const saved = await loadConnections();
      if (!mounted.current) return;
      for (const profile of saved.profiles) registry.connections.set(profile.id, new MobileConnection(profile, fetch as typeof globalThis.fetch, update));
      registry.select(saved.activeId && registry.connections.has(saved.activeId) ? saved.activeId : saved.profiles[0]?.id ?? null);
      await Promise.allSettled([...registry.connections.values()].map(restoreConnection));
      void retryPushRemovals().catch(() => {});
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Unable to restore connections'); }
    finally { if (mounted.current) setReady(true); }
  });
  useEffect(() => {
    mounted.current = true;
    void restore();
    return () => {
      mounted.current = false;
      void Promise.resolve().then(() => { if (!mounted.current) for (const connection of registry.connections.values()) connection.invalidate(); });
    };
  }, [registry]);

  const refreshConnections = useEffectEvent(async () => {
    void retryPushRemovals().catch(() => {});
    await Promise.allSettled([...registry.connections.values()].filter(c => c.session).map(async connection => {
      const session = connection.session!, current = connection.current(session);
      try {
        const info = await connection.api().info();
        if (!current()) return;
        if (info.instance_id !== session.instanceId) { await signOutConnection(connection); return; }
        connection.info = info;
        await loadOrganizations(connection);
        const push = connection.session ? await loadPush(connection.session.connectionId) : null;
        if (push?.pendingRevocation) connection.pushStatus = await revokePush(push.connectionId) ? 'disabled' : 'pending-revocation';
        if (current()) await syncPushLocale(connection.api(), session, current);
        connection.error = '';
      } catch (cause) {
        if (current() && cause instanceof ApiError && [401, 403].includes(cause.status)) await signOutConnection(connection);
        else if (current()) connection.error = 'Unable to refresh connection';
      }
    }));
    update(); await queryClient.invalidateQueries();
  });
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(value => onlineManager.setOnline(value.isConnected !== false));
    let refreshing = false;
    const subscription = AppState.addEventListener('change', next => {
      focusManager.setFocused(next === 'active');
      if (next !== 'active' || refreshing) return;
      refreshing = true; void refreshConnections().finally(() => { refreshing = false; });
    });
    return () => { unsubscribe(); subscription.remove(); };
  }, []);
  const poll = useEffectEvent(async (cursors: Map<string, string>) => {
    await Promise.allSettled([...registry.connections.values()].filter(c => c.session).map(async connection => {
      const remoteId = connection.session!.connectionId;
      const cursor = cursors.get(remoteId) ?? '0';
      try {
        const result = await connection.api().inboxNotifications(cursor);
        cursors.set(remoteId, result.cursor);
        if (result.items.length) await queryClient.invalidateQueries();
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 404) return;
        await Promise.allSettled(connection.organizations.map(async org => {
          const key = sourceKey(remoteId, org.id), result = await connection.api(org.id).notifications(cursors.get(key) ?? '0');
          cursors.set(key, result.cursor); if (result.items.length) await queryClient.invalidateQueries();
        }));
      }
    }));
  });
  useEffect(() => {
    if (!ready) return;
    const cursors = new Map<string, string>(); let running = false;
    const timer = setInterval(() => { if (running || AppState.currentState !== 'active') return; running = true; void poll(cursors).finally(() => { running = false; }); }, 30000);
    return () => clearInterval(timer);
  }, [ready]);
  const syncLocales = useEffectEvent(() => {
    for (const connection of registry.connections.values()) if (connection.session) void syncPushLocale(connection.api(), connection.session, connection.current(connection.session)).catch(() => {});
  });
  useEffect(() => { if (ready) syncLocales(); }, [language, ready]);

  const handleNotification = useEffectEvent(async (response: Notifications.NotificationResponse) => {
    if (!ready) return;
    recordPushDiagnostic('notification_tapped', response.notification);
    const payload = response.notification.request.content.data;
    try {
      if (registrationProof(payload)) {
        const pending = await loadPushProof();
        const connection = pending && connectionForSession(registry.connections, pending.connectionId);
        if (!connection?.session || !connection.info || pushBusy.current.has(connection.profile.id)) return;
        const session = connection.session, current = connection.current(session);
        pushBusy.current.add(connection.profile.id);
        try {
          if (await resumePushRegistration(connection.api(), connection.info, session, payload, current) && current()) { connection.pushStatus = 'enabled'; update(); }
        } finally { pushBusy.current.delete(connection.profile.id); }
        return;
      }
      const data = parseIncidentNotification(payload);
      if (!data) return;
      const identity = sourceKey(data.connection_id, data.organization_id, data.event_id);
      if (notificationIds.current.has(identity)) return;
      const params = await routeIncidentNotification(data, registry.connections, loadOrganizations);
      if (!params) return;
      notificationIds.current.add(identity);
      router.push({ pathname: '/incident/[id]', params });
    } catch { setError('This incident is no longer available'); }
    finally { Notifications.clearLastNotificationResponse(); }
  });
  const rotateTokens = useEffectEvent(() => {
    for (const connection of registry.connections.values()) if (connection.session && connection.pushStatus === 'enabled') void registerConnectionPush(connection).catch(() => {});
  });
  useEffect(() => {
    if (Platform.OS === 'web') return;
    Notifications.setNotificationHandler({ handleNotification: async notification => {
      recordPushDiagnostic('foreground_handler', notification);
      const data = parseIncidentNotification(notification.request.content.data);
      const allowed = allowsNotification(data, registry.connections);
      return { shouldShowBanner: allowed, shouldShowList: allowed, shouldPlaySound: allowed, shouldSetBadge: false };
    } });
    const listener = Notifications.addNotificationResponseReceivedListener(response => { void handleNotification(response); });
    const latest = Notifications.getLastNotificationResponse();
    if (ready && latest) void Promise.resolve().then(() => handleNotification(latest));
    const tokenListener = Notifications.addPushTokenListener(() => rotateTokens());
    return () => { listener.remove(); tokenListener.remove(); };
  }, [ready, registry]);

  const active = currentConnection() ?? empty;
  const list = [...registry.connections.values()];
  const session = active.session;
  const organizationId = active.profile.organizationId ?? null;
  const registerPush = async () => {
    await Promise.allSettled(list.filter(c => c.session).map(registerConnectionPush));
    if (active.pushStatus === 'unavailable') throw new Error('Unable to register notifications');
  };
  const disablePush = async () => { if (currentConnection()) await disableConnectionPush(active); };
  return <Context.Provider value={{ ready, serverUrl: active.profile.serverUrl, info: active.info, session, hasSessions: list.some(c => c.session), organizations: active.organizations, organizationId, organization: active.organizations.find(org => org.id === organizationId) ?? null, api: active.api(organizationId), queryKey: [...cacheKey(active), organizationId], feedKey: ['inbox', ...list.filter(c => c.session).map(c => JSON.stringify([c.profile.id, c.generation, c.session?.connectionId, c.session?.record.id, c.membershipRevision]))], busy, error, authCode, pushStatus: active.pushStatus, connections: list, activeId: registry.activeId, getSource, connect, signIn, signOut, disconnect, setOrganization, selectConnection, renameConnection, removeConnection, registerPush, disablePush }}>{children}</Context.Provider>;
}
export function useI7y() { const value = useContext(Context); if (!value) throw new Error('SessionProvider is required'); return value; }
