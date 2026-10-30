import { fetch } from 'expo/fetch';
import Constants from 'expo-constants';
import { getCalendars } from 'expo-localization';
import { Directory, File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { Platform } from 'react-native';
import { ApiError, normalizeServerUrl } from './client';
import { locale } from '@/locales';
import { allowLocalServers } from './config';
import type { I7yClient } from './client';
import { loadPush, savePush, loadPushProof, savePushProof } from './storage';
import { matchesPendingProof, registrationProof } from './push-proof';
import type { PendingPushProof } from './push-proof';
import type { SavedPush } from './storage';
import type { IncidentNotification, ServerInfo, Session } from './types';

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

export function parseIncidentNotification(data: Record<string, unknown> | undefined): IncidentNotification | null {
  if (!data) return null;
  const keys = ['connection_id', 'organization_id', 'incident_id', 'event_id'] as const;
  if (!keys.every(key => typeof data[key] === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(data[key] as string))) return null;
  return Object.fromEntries(keys.map(key => [key, data[key]])) as unknown as IncidentNotification;
}

export function configuredGateway(info: ServerInfo): string | null {
  const configured = Constants.expoConfig?.extra?.pushGatewayUrl;
  if (typeof configured !== 'string' || !configured || !info.capabilities.includes('push')) return null;
  const expected = normalizeServerUrl(configured, allowLocalServers);
  if (info.push_gateway_url !== expected) return null;
  return expected;
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

async function revokeStoredPush(): Promise<boolean> {
  await savePushProof(null);
  const saved = await loadPush();
  if (!saved) return true;
  await savePush({ ...saved, pendingRevocation: true });
  try {
    await gateway(saved.gatewayUrl, '/v1/bindings/' + encodeURIComponent(saved.bindingId), 'DELETE', undefined, saved.managementToken);
  } catch (error) {
    if (!(error instanceof ApiError) || ![401, 404].includes(error.status)) return false;
  }
  await savePush(null);
  await Notifications.dismissAllNotificationsAsync();
  return true;
}

export function revokePush() { return exclusive(revokeStoredPush); }

async function completeRegistration(api: I7yClient, info: ServerInfo, session: Session, pending: PendingPushProof, nonce: string, isCurrent: () => boolean): Promise<'enabled'> {
  recordPushDiagnostic('confirming');
  const { gatewayUrl, registrationId, nativeToken } = pending;
  let saved: SavedPush | null = null;
  try {
    if (!isCurrent()) throw new Error('Connection context changed');
    const device = await gateway<{ device_id: string; management_token: string }>(gatewayUrl, '/v1/registrations/' + encodeURIComponent(registrationId) + '/confirm', 'POST', { nonce: nonce });
    if (!isCurrent()) throw new Error('Connection context changed');
    const binding = await gateway<{ binding_id: string; send_token: string }>(gatewayUrl, '/v1/bindings', 'POST', { device_id: device.device_id, connection_id: session.connectionId, server_instance_id: info.instance_id }, device.management_token);
    saved = { gatewayUrl, deviceId: device.device_id, managementToken: device.management_token, bindingId: binding.binding_id, connectionId: session.connectionId, nativeToken };
    await savePush({ ...saved, pendingRevocation: true });
    if (!isCurrent()) throw new Error('Connection context changed');
    const backend = await api.request<{ id: string }>('/api/i7y/mobile/v1/devices', { method: 'POST', body: { connection_id: session.connectionId, binding_id: binding.binding_id, send_token: binding.send_token, locale: locale(), time_zone: deviceTimeZone() } });
    if (!isCurrent()) throw new Error('Connection context changed');
    await savePush({ ...saved, backendDeviceId: backend.id });
    await savePushProof(null);
    return 'enabled';
  } catch (error) {
    if (saved) await revokeStoredPush();
    throw error;
  }
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
  if (!await revokeStoredPush()) throw new Error('Previous notification connection must be revoked first');
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
    const registration = await registrationStep('gateway_registration', () => gateway<{ registration_id: string; expires_at: string }>(gatewayUrl, '/v1/registrations', 'POST', { platform, token: nativeToken, environment, app_id: appId }));
    recordPushDiagnostic('provider_accepted');
    registrationId = registration.registration_id;
    const pending: PendingPushProof = { registrationId, expiresAt: registration.expires_at, gatewayUrl, nativeToken, connectionId: session.connectionId, serverUrl: session.serverUrl, instanceId: session.instanceId };
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
    const saved = await loadPush();
    if (!isCurrent() || locale() !== language || !saved?.backendDeviceId || saved.pendingRevocation || saved.connectionId !== session.connectionId) return;
    await api.request('/api/i7y/mobile/v1/devices/' + encodeURIComponent(saved.backendDeviceId), { method: 'PATCH', body: { locale: language, time_zone: deviceTimeZone() } });
  });
  localeUpdates = update;
  return update;
}
