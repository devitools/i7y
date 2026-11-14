import { fetch } from 'expo/fetch';
import Constants from 'expo-constants';
import { getCalendars } from 'expo-localization';
import { Directory, File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { Platform } from 'react-native';
import { ApiError } from './client';
import { locale } from '@/locales';
import { allowLocalServers } from './config';
import type { I7yClient } from './client';
import { loadPush, savePush, loadPushProof, savePushProof, loadPushStore, mutatePushStore } from './storage';
import { parseIncidentNotification } from './notification-router';
import { canonicalGateway, selectGateway } from './push-config';
import { matchesPendingProof, registrationProof } from './push-proof';
import type { PendingPushProof } from './push-proof';
import type { SavedPush } from './storage';
import type { ServerInfo, Session } from './types';

export class PushRegistrationError extends Error {
  constructor(public stage: string, public code: string) { super(stage + ': ' + code); }
}
async function registrationStep<T>(stage: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof PushRegistrationError) throw error;
    const nativeCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    throw new PushRegistrationError(stage, error instanceof ApiError ? 'HTTP ' + error.status : typeof nativeCode === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(nativeCode) ? nativeCode : 'request_failed');
  }
}

export function recordPushDiagnostic(stage: string, notification?: Notifications.Notification) {
  if (Constants.expoConfig?.extra?.buildVariant !== 'development') return;
  try {
    const directory = new Directory(Paths.document, 'i7y-private');
    directory.create({ intermediates: true, idempotent: true });
    const file = new File(directory, 'push-diagnostics.json');
    const previous = file.exists ? JSON.parse(file.textSync()) : [];
    const data = notification?.request.content.data;
    const trigger = notification?.request.trigger;
    const payload = trigger && 'payload' in trigger ? trigger.payload as Record<string, unknown> : undefined;
    const event = { stage, time: new Date().toISOString(), hasData: !!data, hasProof: !!registrationProof(data), hasPayloadProof: !!registrationProof(payload), hasBodyProof: !!registrationProof(payload?.body as Record<string, unknown> | undefined), trigger: trigger && 'type' in trigger ? trigger.type : undefined };
    file.write(JSON.stringify([...previous.slice(-29), event]));
  } catch {}
}

const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || getCalendars()[0]?.timeZone || 'UTC';

export const appId = 'com.devitools.i7y.mobile';
let operations: Promise<unknown> = Promise.resolve();
function exclusive<T>(action: () => Promise<T>): Promise<T> {
  const next = operations.catch(() => {}).then(action);
  operations = next;
  return next;
}

export { parseIncidentNotification } from './notification-router';
export function configuredGateway(info: ServerInfo): string | null {
  return selectGateway(info, Constants.expoConfig?.extra?.pushGatewayUrl, allowLocalServers);
}

async function gateway<T>(base: string, path: string, method: string, body?: unknown, token?: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(base + path, {
      method, redirect: 'error', credentials: 'omit', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = response.status === 204 ? null : await response.json();
    if (!response.ok && method === 'DELETE') throw new ApiError(response.status, 'Push service request failed');
    if (!response.ok) throw new PushRegistrationError('gateway', 'HTTP ' + response.status + (typeof result?.error === 'string' && /^[a-z_]{1,64}$/.test(result.error) ? ' ' + result.error : ''));
    return result as T;
  } finally { clearTimeout(timeout); }
}

async function revokeStoredPush(connectionId: string): Promise<boolean> {
  const pending = await loadPushProof();
  if (pending?.connectionId === connectionId) await savePushProof(null);
  const saved = await loadPush(connectionId);
  if (!saved) return true;
  await savePush(connectionId, { ...saved, pendingRevocation: true });
  try {
    await gateway(saved.gatewayUrl, `/v${saved.version ?? 1}/bindings/` + encodeURIComponent(saved.bindingId), 'DELETE', undefined, saved.managementToken);
  } catch (error) {
    if (!(error instanceof ApiError) || ![401, 404].includes(error.status)) return false;
  }
  await savePush(connectionId, null);
  const notifications = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(notifications.filter(notification => parseIncidentNotification(notification.request.content.data)?.connection_id === connectionId).map(notification => Notifications.dismissNotificationAsync(notification.request.identifier)));
  return true;
}

export function revokePush(connectionId: string) { return exclusive(() => revokeStoredPush(connectionId)); }

async function bindDevice(api: I7yClient, info: ServerInfo, session: Session, device: { gatewayUrl: string; deviceId: string; managementToken: string; nativeToken: string; key: string }, isCurrent: () => boolean): Promise<'enabled'> {
  if (!isCurrent()) throw new Error('Connection context changed');
  const previous = await loadPush(session.connectionId);
  if (previous && previous.deviceKey !== device.key && !await revokeStoredPush(session.connectionId)) throw new Error('Previous notification environment must be revoked first');
  if (!isCurrent()) throw new Error('Connection context changed');
  const binding = await gateway<{ binding_id: string; send_token: string }>(device.gatewayUrl, '/v2/bindings', 'POST', { device_id: device.deviceId, connection_id: session.connectionId, server_instance_id: info.instance_id }, device.managementToken);
  const saved: SavedPush = { gatewayUrl: device.gatewayUrl, deviceId: device.deviceId, managementToken: device.managementToken, bindingId: binding.binding_id, connectionId: session.connectionId, nativeToken: device.nativeToken, version: 2, deviceKey: device.key };
  await savePush(session.connectionId, { ...saved, pendingRevocation: true });
  try {
    if (!isCurrent()) throw new Error('Connection context changed');
    const backend = await api.request<{ id: string }>('/api/i7y/mobile/v1/devices', { method: 'POST', body: { connection_id: session.connectionId, binding_id: binding.binding_id, send_token: binding.send_token, locale: locale(), time_zone: deviceTimeZone() } });
    if (!isCurrent()) throw new Error('Connection context changed');
    await savePush(session.connectionId, { ...saved, backendDeviceId: backend.id });
    return 'enabled';
  } catch (error) { await revokeStoredPush(session.connectionId); throw error; }
}

async function completeRegistration(api: I7yClient, info: ServerInfo, session: Session, pending: PendingPushProof, nonce: string, isCurrent: () => boolean): Promise<'enabled'> {
  recordPushDiagnostic('confirming');
  if (!isCurrent()) throw new Error('Connection context changed');
  const store = await loadPushStore();
  const existing = pending.deviceKey ? store.devices[pending.deviceKey] : undefined;
  const device = await gateway<{ device_id: string; management_token: string }>(pending.gatewayUrl, `/v${pending.version ?? 1}/registrations/` + encodeURIComponent(pending.registrationId) + '/confirm', 'POST', { nonce }, existing?.deviceId === pending.deviceId ? existing?.managementToken : undefined);
  const key = pending.deviceKey ?? canonicalGateway(pending.gatewayUrl);
  const saved = { key, gatewayUrl: pending.gatewayUrl, deviceId: device.device_id, managementToken: device.management_token, nativeToken: pending.nativeToken, environment: pending.environment ?? '', appId };
  await mutatePushStore(current => { current.devices[key] = saved; });
  await savePushProof(null);
  return bindDevice(api, info, session, saved, isCurrent);
}
export function resumePushRegistration(api: I7yClient, info: ServerInfo, session: Session, data: Record<string, unknown> | undefined, isCurrent: () => boolean) {
  return exclusive(async () => {
    const proof = registrationProof(data);
    const pending = await loadPushProof();
    if (!proof || !pending || !isCurrent() || !matchesPendingProof(pending, proof.registrationId, session, configuredGateway(info))) return false;
    await completeRegistration(api, info, session, pending, proof.nonce, isCurrent);
    return true;
  });
}

async function enroll(api: I7yClient, info: ServerInfo, session: Session, isCurrent: () => boolean): Promise<'enabled' | 'denied' | 'unconfigured'> {
  recordPushDiagnostic('start');
  const gatewayUrl = configuredGateway(info);
  if (!gatewayUrl || Platform.OS === 'web') return 'unconfigured';
  if (!isCurrent()) throw new Error('Connection context changed');
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('incidents', {
    name: 'Incidents', importance: AndroidImportance.HIGH, sound: 'default',
  });
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return 'denied';
  const native = await registrationStep('apple_token', () => Notifications.getDevicePushTokenAsync());
  recordPushDiagnostic('native_token_ready');
  const nativeToken = String(native.data);
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const environment = platform === 'ios' && Constants.expoConfig?.extra?.pushEnvironment !== 'production' ? 'sandbox' : 'production';
  const store = await loadPushStore();
  const key = JSON.stringify([canonicalGateway(gatewayUrl), appId, environment]);
  let device = store.devices[key];
  const legacyKey = canonicalGateway(gatewayUrl);
  if (!device && store.devices[legacyKey]) {
    device = { ...store.devices[legacyKey], key, environment, gatewayUrl };
    const migrated = device;
    await mutatePushStore(current => {
      delete current.devices[legacyKey];
      current.devices[key] = migrated;
      for (const binding of Object.values(current.bindings)) if (binding.deviceKey === legacyKey) binding.deviceKey = key;
    });
  }
  if (device?.nativeToken === nativeToken) {
    const existing = await loadPush(session.connectionId);
    if (existing && existing.deviceKey === key && !existing.pendingRevocation) { await syncPushLocale(api, session, isCurrent); return 'enabled'; }
    return bindDevice(api, info, session, { ...device, gatewayUrl }, isCurrent);
  }
  const challenges = new Map<string, string>();
  let registrationId = '';
  let notify: (() => void) | undefined;
  const receive = (notification: Notifications.Notification) => {
    recordPushDiagnostic('received', notification);
    const data = notification.request.content.data ?? {};
    if (data.kind === 'registration_challenge' && typeof data.registration_id === 'string' && typeof data.nonce === 'string') {
      if (challenges.size < 8) challenges.set(data.registration_id, data.nonce);
      if (data.registration_id === registrationId) notify?.();
    }
  };
  const subscription = Notifications.addNotificationReceivedListener(receive);
  const responseSubscription = Notifications.addNotificationResponseReceivedListener(response => receive(response.notification));
  try {
    const registration = await registrationStep('gateway_registration', () => gateway<{ registration_id: string; expires_at: string }>(gatewayUrl, '/v2/registrations', 'POST', { platform, token: nativeToken, environment, app_id: appId, ...(device ? { device_id: device.deviceId } : {}) }, device?.managementToken));
    recordPushDiagnostic('provider_accepted');
    registrationId = registration.registration_id;
    const pending: PendingPushProof = { registrationId, expiresAt: registration.expires_at, gatewayUrl, nativeToken, connectionId: session.connectionId, serverUrl: session.serverUrl, instanceId: session.instanceId, version: 2, deviceKey: key, deviceId: device?.deviceId, environment };
    if (!isCurrent()) throw new Error('Connection context changed');
    await savePushProof(pending);
    if (!challenges.has(registrationId)) await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timeout); clearInterval(cancel); if (error) reject(error); else resolve(); };
      const timeout = setTimeout(() => { recordPushDiagnostic('confirmation_timeout'); finish(new PushRegistrationError('apple_delivery', 'confirmation_timeout')); }, 45000);
      const cancel = setInterval(() => { if (!isCurrent()) finish(new Error('Connection context changed')); }, 100);
      notify = () => finish();
    });
    if (!isCurrent()) throw new Error('Connection context changed');
    return await completeRegistration(api, info, session, pending, challenges.get(registrationId)!, isCurrent);
  } finally { subscription.remove(); responseSubscription.remove(); }
}

export function enrollPush(api: I7yClient, info: ServerInfo, session: Session, isCurrent: () => boolean) {
  return exclusive(() => enroll(api, info, session, isCurrent));
}

let localeUpdates: Promise<void> = Promise.resolve();
export function syncPushLocale(api: I7yClient, session: Session, isCurrent: () => boolean) {
  const language = locale();
  const update = localeUpdates.catch(() => {}).then(async () => {
    const saved = await loadPush(session.connectionId);
    if (!isCurrent() || locale() !== language || !saved?.backendDeviceId || saved.pendingRevocation || saved.connectionId !== session.connectionId) return;
    await api.request('/api/i7y/mobile/v1/devices/' + encodeURIComponent(saved.backendDeviceId), { method: 'PATCH', body: { locale: language, time_zone: deviceTimeZone() } });
  });
  localeUpdates = update;
  return update;
}
