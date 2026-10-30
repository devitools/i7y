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
import { ApiError, AuthorizationCancelledError, ContextChangedError, I7yClient, normalizeServerUrl } from '@/core/client';
import { useLocale } from '@/locales';
import { registrationProof } from '@/core/push-proof';
import { allowLocalServers } from '@/core/config';
import type { ClientState } from '@/core/client';
import type { Organization, PushStatus, ServerInfo, Session, User } from '@/core/types';
import { loadPreferences, loadPush, loadSession, prepareStorage, savePreferences, saveSession } from '@/core/storage';
import { configuredGateway, enrollPush, parseIncidentNotification, revokePush, resumePushRegistration, PushRegistrationError, recordPushDiagnostic, syncPushLocale } from '@/core/push';

const redirectUrl = 'com.devitools.i7y.mobile://auth/callback';
type AppSession = {
  ready: boolean; serverUrl: string; info: ServerInfo | null; session: Session | null;
  organizations: Organization[]; organizationId: string | null; organization: Organization | null;
  api: I7yClient; queryKey: readonly unknown[]; busy: boolean; error: string; authCode: string; pushStatus: PushStatus;
  connect: (url: string) => Promise<void>; signIn: (url?: string) => Promise<void>; signOut: () => Promise<void>;
  disconnect: () => Promise<void>; setOrganization: (id: string) => void;
  registerPush: () => Promise<void>; disablePush: () => Promise<void>;
};
const Context = createContext<AppSession | null>(null);
const secret = () => Array.from(Crypto.getRandomBytes(32), n => n.toString(16).padStart(2, '0')).join('');
function userRecord(record: User): User { return { id: record.id, email: record.email, name: record.name, global_admin: record.global_admin }; }

class ConnectionState {
  private value: ClientState = { serverUrl: '', session: null, organizationId: null };
  get current() { return this.value; }
  update(value: Partial<ClientState>) { this.value = { ...this.value, ...value }; }
}

export function SessionProvider({ children }: PropsWithChildren) {
  const language = useLocale();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [state] = useState(() => new ConnectionState());
  const [api] = useState(() => new I7yClient(() => state.current, fetch as typeof globalThis.fetch));
  const [ready, setReady] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [pushStatus, setPushStatus] = useState<PushStatus>('disabled');
  const operation = useRef(0);
  const pushBusy = useRef(false);
  const pushGeneration = useRef(0);
  const operationBusy = useRef(false);
  const mounted = useRef(true);
  const infoRef = useRef<ServerInfo | null>(null);
  const orgRef = useRef<Organization[]>([]);
  const notificationIds = useRef(new Set<string>());

  function clearPrivateState() {
    operation.current++;
    api.invalidate();
    state.update({ session: null, organizationId: null });
    orgRef.current = [];
    setSession(null); setOrganizations([]); setOrganizationId(null); setAuthCode('');
    queryClient.clear(); notificationIds.current.clear();
  }
  function applyInfo(value: ServerInfo) { infoRef.current = value; setInfo(value); }
  async function loadOrganizations(preferred?: string) {
    const current = state.current.session;
    const result = await api.organizations();
    if (current !== state.current.session) return;
    orgRef.current = result.items;
    setOrganizations(result.items);
    const selected = result.items.find(org => org.id === (preferred ?? state.current.organizationId))?.id ?? result.items[0]?.id ?? null;
    state.update({ organizationId: selected });
    setOrganizationId(selected);
    await savePreferences({ serverUrl: state.current.serverUrl, instanceId: infoRef.current?.instance_id, organizationId: selected ?? undefined });
  }
  async function installSession(value: Session, preferred?: string, generation = operation.current) {
    const current = () => generation === operation.current && value.serverUrl === state.current.serverUrl && value.instanceId === infoRef.current?.instance_id;
    if (!current()) throw new ContextChangedError();
    await saveSession(value, current);
    if (!current()) throw new ContextChangedError();
    state.update({ session: value });
    setSession(value);
    await loadOrganizations(preferred);
  }
  async function run(action: () => Promise<void>) {
    if (operationBusy.current) return;
    operationBusy.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (cause) { if (mounted.current && !(cause instanceof AuthorizationCancelledError)) setError(cause instanceof Error ? cause.message : 'Unable to complete this action'); throw cause; }
    finally { operationBusy.current = false; if (mounted.current) { setBusy(false); setAuthCode(''); } }
  }
  async function disablePush(previousSession = state.current.session) {
    const generation = ++pushGeneration.current;
    const previous = await loadPush();
    const revoked = await revokePush();
    if (generation === pushGeneration.current) setPushStatus(revoked ? 'disabled' : 'pending-revocation');
    if (previous?.backendDeviceId && previousSession?.connectionId === previous.connectionId) {
      const oldClient = new I7yClient(() => ({ serverUrl: previousSession.serverUrl, session: previousSession, organizationId: null }), fetch as typeof globalThis.fetch);
      try { await oldClient.request('/api/i7y/mobile/v1/devices/' + encodeURIComponent(previous.backendDeviceId), { method: 'DELETE' }); } catch {}
    }
  }
  async function signOut() {
    const previous = state.current.session;
    clearPrivateState();
    await Promise.all([saveSession(null), disablePush(previous)]);
  }
  async function disconnect() {
    const signedOut = signOut();
    state.update({ serverUrl: '' }); setServerUrl(''); infoRef.current = null; setInfo(null);
    await Promise.all([signedOut, savePreferences({ serverUrl: '' })]);
  }
  async function connect(input: string) {
    await run(async () => {
      const target = normalizeServerUrl(input, allowLocalServers);
      const verified = await api.info(target);
      if (state.current.serverUrl !== target || infoRef.current?.instance_id !== verified.instance_id) await signOut();
      state.update({ serverUrl: target }); setServerUrl(target); applyInfo(verified);
      await savePreferences({ serverUrl: target, instanceId: verified.instance_id });
      if (!configuredGateway(verified)) setPushStatus('unconfigured');
    });
  }
  async function signIn(input?: string) {
    await run(async () => {
      const origin = normalizeServerUrl(input ?? state.current.serverUrl, allowLocalServers);
      await signOut();
      state.update({ serverUrl: origin }); setServerUrl(origin);
      infoRef.current = null; setInfo(null);
      await savePreferences({ serverUrl: origin });
      const verified = await api.info(origin);
      applyInfo(verified);
      await savePreferences({ serverUrl: origin, instanceId: verified.instance_id });
      const generation = operation.current;
      const request = secret(), verifier = secret();
      const challenge = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier);
      setAuthCode(request.slice(0, 8).toUpperCase());
      const query = new URLSearchParams({ request, challenge, instance_id: verified.instance_id });
      const result = await WebBrowser.openAuthSessionAsync(origin + '/mobile-auth.html#/mobile-authorize?' + query.toString(), redirectUrl);
      if (generation !== operation.current || state.current.serverUrl !== origin) throw new Error('Connection context changed');
      if (result.type !== 'success') throw new AuthorizationCancelledError();
      if (result.type === 'success') {
        const callback = new URL(result.url);
        if (callback.origin !== 'null' || callback.protocol !== 'com.devitools.i7y.mobile:' || callback.hostname !== 'auth' || callback.pathname !== '/callback' || callback.searchParams.get('request') !== request) throw new Error('Invalid authorization callback');
      }
      const response = await api.request<{ token?: string; record?: User; pending?: boolean; meta?: { instance_id: string } }>('/api/i7y/mobile/v1/auth/exchange', { method: 'POST', public: true, body: { request, verifier, instance_id: verified.instance_id } });
      if (!response.token || !response.record || response.meta?.instance_id !== verified.instance_id) throw new Error(response.pending ? 'Authorization was not completed. Start again.' : 'The server could not complete mobile authorization');
      if (generation !== operation.current) throw new Error('Connection context changed');
      await installSession({ token: response.token, record: userRecord(response.record), connectionId: Crypto.randomUUID(), serverUrl: origin, instanceId: verified.instance_id }, undefined, generation);
    });
  }
  function setOrganization(id: string) {
    if (!orgRef.current.some(org => org.id === id) || id === state.current.organizationId) return;
    api.invalidate(); queryClient.clear();
    state.update({ organizationId: id }); setOrganizationId(id);
    void savePreferences({ serverUrl: state.current.serverUrl, instanceId: infoRef.current?.instance_id, organizationId: id }).catch(() => setError('Unable to save organization preference'));
  }
  async function registerPush() {
    if (pushBusy.current || !state.current.session || !infoRef.current) return;
    pushBusy.current = true; setPushStatus('registering');
    const current = state.current.session;
    const generation = ++pushGeneration.current;
    try {
      const result = await enrollPush(api, infoRef.current, current, () => state.current.session?.connectionId === current.connectionId && generation === pushGeneration.current);
      if (state.current.session?.connectionId === current.connectionId && generation === pushGeneration.current) setPushStatus(result);
    } catch (cause) {
      const saved = await loadPush();
      if (generation === pushGeneration.current) setPushStatus(saved?.pendingRevocation ? 'pending-revocation' : 'unavailable');
      throw cause;
    } finally { pushBusy.current = false; }
  }
  async function restore(generation: number) {
    const current = () => mounted.current && generation === operation.current;
    await prepareStorage();
    const prefs = await loadPreferences();
    const saved = await loadSession();
    if (!current()) throw new ContextChangedError();
    if (!prefs.serverUrl) return;
    const origin = normalizeServerUrl(prefs.serverUrl, allowLocalServers);
    state.update({ serverUrl: origin }); setServerUrl(origin);
    const verified = await api.info();
    if (!current()) throw new ContextChangedError();
    applyInfo(verified);
    if (saved && saved.serverUrl === origin && saved.instanceId === verified.instance_id) {
      state.update({ session: saved });
      try {
        const refreshed = await api.request<{ token: string; record: User }>('/api/collections/users/auth-refresh', { method: 'POST' });
        await installSession({ ...saved, token: refreshed.token, record: userRecord(refreshed.record) }, prefs.organizationId, generation);
      } catch (cause) {
        if (!current()) throw new ContextChangedError();
        state.update({ session: null });
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) await saveSession(null);
        else throw cause;
      }
    } else if (saved) { await saveSession(null); await revokePush(); }
    const push = await loadPush();
    if (!current()) throw new ContextChangedError();
    if (push?.pendingRevocation || (push && push.connectionId !== state.current.session?.connectionId)) {
      setPushStatus(await revokePush() ? 'disabled' : 'pending-revocation');
    } else setPushStatus(push ? 'enabled' : configuredGateway(verified) ? 'disabled' : 'unconfigured');
  }

  const restoreConnection = useEffectEvent(async (generation: number) => {
    try { await restore(generation); }
    catch (cause) {
      if (mounted.current && generation === operation.current && !(cause instanceof ContextChangedError)) setError(cause instanceof Error ? cause.message : 'Unable to restore connection');
    } finally { if (mounted.current && generation === operation.current) setReady(true); }
  });
  useEffect(() => {
    mounted.current = true;
    const generation = ++operation.current;
    void restoreConnection(generation);
    return () => { mounted.current = false; operation.current = generation + 1; api.invalidate(); };
  }, [api]);

  const refreshConnection = useEffectEvent(async () => {
    const active = state.current.session;
    if (!active) return;
    try {
      const value = await api.info();
      if (state.current.session !== active) return;
      if (value.instance_id !== active.instanceId) { await signOut(); applyInfo(value); return; }
      applyInfo(value);
      await loadOrganizations();
      const pending = await loadPush();
      if (state.current.session !== active) return;
      if (!pushBusy.current) {
        if (pending?.pendingRevocation) setPushStatus(await revokePush() ? 'disabled' : 'pending-revocation');
        else if (!configuredGateway(value)) setPushStatus('unconfigured');
        else setPushStatus(previous => previous === 'unconfigured' ? pending ? 'enabled' : 'disabled' : previous);
      }
      await syncPushLocale(api, active, () => state.current.session?.connectionId === active.connectionId);
      await queryClient.invalidateQueries();
    } catch (cause) {
      if (state.current.session === active && cause instanceof ApiError && [401, 403].includes(cause.status)) await signOut();
    }
  });

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(value => onlineManager.setOnline(value.isConnected !== false));
    let refreshing = false;
    const subscription = AppState.addEventListener('change', next => {
      focusManager.setFocused(next === 'active');
      if (next !== 'active' || !state.current.session || refreshing) return;
      refreshing = true;
      void refreshConnection().finally(() => { refreshing = false; });
    });
    return () => { unsubscribe(); subscription.remove(); };
  }, [state]);

  useEffect(() => {
    if (!ready || !session || !organizationId) return;
    let cursor = '0', running = false;
    const tick = async () => {
      if (running || AppState.currentState !== 'active') return;
      running = true;
      try { const result = await api.notifications(cursor); cursor = result.cursor; if (result.items.length) await queryClient.invalidateQueries(); }
      catch {} finally { running = false; }
    };
    const timer = setInterval(() => void tick(), 30000);
    return () => clearInterval(timer);
  }, [api, queryClient, ready, session, organizationId]);

  useEffect(() => {
    const active = session;
    if (!ready || !active || pushStatus !== 'enabled') return;
    let current = true;
    void syncPushLocale(api, active, () => current && state.current.session?.connectionId === active.connectionId).catch(() => {});
    return () => { current = false; };
  }, [language, session, ready, pushStatus, api, state]);

  const handleNotification = useEffectEvent((response: Notifications.NotificationResponse) => {
    recordPushDiagnostic('notification_tapped', response.notification);
    if (!ready || !state.current.session) return;
    const payload = response.notification.request.content.data;
    if (registrationProof(payload)) {
      if (pushBusy.current || !infoRef.current) return;
      const active = state.current.session;
      const verified = infoRef.current;
      const generation = ++pushGeneration.current;
      const current = () => state.current.session?.connectionId === active.connectionId && generation === pushGeneration.current;
      pushBusy.current = true;
      void resumePushRegistration(api, verified, active, payload, current).then(completed => {
        if (completed && current()) { setPushStatus('enabled'); setError(''); }
      }).catch(cause => {
        if (current()) { setPushStatus('unavailable'); setError(cause instanceof PushRegistrationError ? cause.message : 'Unable to complete notification registration'); }
      }).finally(() => { pushBusy.current = false; Notifications.clearLastNotificationResponse(); });
      return;
    }
    const data = parseIncidentNotification(payload);
    if (!data || data.connection_id !== state.current.session.connectionId) { Notifications.clearLastNotificationResponse(); return; }
    if (notificationIds.current.has(data.event_id)) return;
    notificationIds.current.add(data.event_id);
    const connection = state.current.session.connectionId;
    void loadOrganizations().then(async () => {
      if (state.current.session?.connectionId !== connection || !orgRef.current.some(org => org.id === data.organization_id)) return;
      setOrganization(data.organization_id);
      await api.incident(data.incident_id);
      if (state.current.session?.connectionId !== connection || state.current.organizationId !== data.organization_id) return;
      router.push({ pathname: '/incident/[id]', params: { id: data.incident_id } });
    }).catch(cause => {
      if (state.current.session?.connectionId === connection && !(cause instanceof ContextChangedError)) setError('This incident is no longer available');
    }).finally(() => Notifications.clearLastNotificationResponse());
  });
  const handleTokenChange = useEffectEvent(() => {
    if (pushStatus === 'enabled') void registerPush().catch(() => {});
  });

  useEffect(() => {
    if (Platform.OS === 'web') return;
    Notifications.setNotificationHandler({ handleNotification: async notification => {
      recordPushDiagnostic('foreground_handler', notification);
      const data = parseIncidentNotification(notification.request.content.data);
      const allowed = !!data && data.connection_id === state.current.session?.connectionId;
      return { shouldShowBanner: allowed, shouldShowList: allowed, shouldPlaySound: allowed, shouldSetBadge: false };
    } });
    const listener = Notifications.addNotificationResponseReceivedListener(response => handleNotification(response));
    const latest = Notifications.getLastNotificationResponse();
    if (latest) handleNotification(latest);
    const tokenListener = Notifications.addPushTokenListener(() => handleTokenChange());
    return () => { listener.remove(); tokenListener.remove(); };
  }, [ready, session?.connectionId, pushStatus, state]);

  return <Context.Provider value={{ ready, serverUrl, info, session, organizations, organizationId, organization: organizations.find(org => org.id === organizationId) ?? null, api, queryKey: [serverUrl, info?.instance_id, session?.connectionId, session?.record.id, organizationId], busy, error, authCode, pushStatus, connect, signIn, signOut, disconnect, setOrganization, registerPush, disablePush }}>{children}</Context.Provider>;
}

export function useI7y() {
  const value = useContext(Context);
  if (!value) throw new Error('SessionProvider is required');
  return value;
}
