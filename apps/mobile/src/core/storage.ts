import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { canonicalGateway } from './push-config';
import { connectionPreferencesKey, connectionSessionKey, migrateConnections, parseStored } from './connection-storage';
import type { PendingPushProof } from './push-proof';
import type { ConnectionPreferences, PushRegistration, Session } from './types';

const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const memory = new Map<string, string>();
const queues = new Map<string, Promise<void>>();
const secureRead = (key: string) => Platform.OS === 'web' ? Promise.resolve(memory.get(key) ?? null) : SecureStore.getItemAsync(key, options);
function secureWrite(key: string, value: string | null, current: () => boolean = () => true) {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (!current()) return;
    if (Platform.OS === 'web') { if (value === null) memory.delete(key); else memory.set(key, value); return; }
    if (value === null) await SecureStore.deleteItemAsync(key, options);
    else await SecureStore.setItemAsync(key, value, options);
  });
  queues.set(key, next);
  return next;
}
export interface SavedPush extends PushRegistration { pendingRevocation?: boolean }
export interface PushDevice { key: string; gatewayUrl: string; deviceId: string; managementToken: string; nativeToken: string; environment: string; appId: string }
export interface PushStore { devices: Record<string, PushDevice>; bindings: Record<string, Omit<SavedPush, 'managementToken' | 'nativeToken' | 'deviceId'>> }
const pushStoreKey = 'i7y.mobile.push.v2';
const pushManifestKey = 'i7y.mobile.push.manifest.v3';
interface PushManifest { version: 3; devices: { key: string; storageKey: string }[]; bindings: string[] }
const bindingStorageKey = (id: string) => 'i7y.mobile.push-binding.' + id;
async function deviceStorageKey(key: string) {
  return 'i7y.mobile.push-device.' + await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key);
}
let pushWrites: Promise<void> = Promise.resolve();
let pushMigration: Promise<void> | null = null;
const pushProofKey = 'i7y.mobile.push-proof';

export async function prepareStorage() {
  if (Platform.OS === 'web') return;
  const directory = new Directory(Paths.document, 'i7y-private');
  directory.create({ intermediates: true, idempotent: true });
  const marker = new File(directory, 'installation');
  if (!marker.exists) {
    const preferences = await AsyncStorage.getItem(connectionPreferencesKey) || await AsyncStorage.getItem('i7y.mobile.preferences');
    if (!preferences) {
      await secureWrite('i7y.mobile.session', null);
      await secureWrite(pushProofKey, null);
      await mutatePushStore(push => { for (const binding of Object.values(push.bindings)) binding.pendingRevocation = true; });
    }
    marker.create({ overwrite: true });
    marker.write('1');
  }
}
export function loadConnections() {
  return migrateConnections({ read: key => AsyncStorage.getItem(key), write: (key, value) => value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value), secureRead, secureWrite }, () => Crypto.randomUUID());
}
let preferenceWrites = Promise.resolve();
export function saveConnections(value: ConnectionPreferences) {
  const serialized = JSON.stringify(value);
  preferenceWrites = preferenceWrites.catch(() => {}).then(() => AsyncStorage.setItem(connectionPreferencesKey, serialized));
  return preferenceWrites;
}
export async function loadSession(id: string): Promise<Session | null> { return parseStored(await secureRead(connectionSessionKey(id))); }
export function saveSession(id: string, value: Session | null, current: () => boolean = () => true) { return secureWrite(connectionSessionKey(id), value ? JSON.stringify(value) : null, current); }
async function writePushStore(value: PushStore) {
  const previous = parseStored<PushManifest>(await AsyncStorage.getItem(pushManifestKey));
  const devices = await Promise.all(Object.keys(value.devices).map(async key => ({ key, storageKey: await deviceStorageKey(key) })));
  const manifest: PushManifest = { version: 3, devices, bindings: Object.keys(value.bindings) };
  await Promise.all([
    ...devices.map(device => secureWrite(device.storageKey, JSON.stringify(value.devices[device.key]))),
    ...manifest.bindings.map(id => secureWrite(bindingStorageKey(id), JSON.stringify(value.bindings[id]))),
  ]);
  await AsyncStorage.setItem(pushManifestKey, JSON.stringify(manifest));
  await Promise.all([
    ...(previous?.devices ?? []).filter(device => !devices.some(next => next.storageKey === device.storageKey)).map(device => secureWrite(device.storageKey, null)),
    ...(previous?.bindings ?? []).filter(id => !manifest.bindings.includes(id)).map(id => secureWrite(bindingStorageKey(id), null)),
  ]);
}
async function migratePushStore() {
  const manifest = parseStored<PushManifest>(await AsyncStorage.getItem(pushManifestKey));
  if (manifest?.version === 3) {
    await secureWrite(pushStoreKey, null);
    await secureWrite('i7y.mobile.push', null);
    return;
  }
  const previous = parseStored<PushStore>(await secureRead(pushStoreKey));
  const legacy = previous ? null : parseStored<SavedPush>(await secureRead('i7y.mobile.push'));
  const store: PushStore = previous ?? { devices: {}, bindings: {} };
  if (legacy) {
    const key = canonicalGateway(legacy.gatewayUrl);
    store.devices[key] = { key, gatewayUrl: legacy.gatewayUrl, deviceId: legacy.deviceId, managementToken: legacy.managementToken, nativeToken: legacy.nativeToken, environment: '', appId: 'com.devitools.i7y.mobile' };
    const { managementToken: _management, nativeToken: _native, deviceId: _device, ...binding } = legacy;
    store.bindings[legacy.connectionId] = { ...binding, version: 1, deviceKey: key };
  }
  await writePushStore(store);
  await secureWrite(pushStoreKey, null);
  await secureWrite('i7y.mobile.push', null);
}
async function ensurePushStorage() {
  if (!pushMigration) pushMigration = migratePushStore().catch(error => { pushMigration = null; throw error; });
  await pushMigration;
}
function queuePush<T>(action: () => Promise<T>): Promise<T> {
  const next = pushWrites.catch(() => {}).then(action);
  pushWrites = next.then(() => {}, () => {});
  return next;
}
async function readPushStore(): Promise<PushStore> {
  const manifest = parseStored<PushManifest>(await AsyncStorage.getItem(pushManifestKey));
  if (!manifest || manifest.version !== 3) throw new Error('Push storage unavailable');
  const devices = await Promise.all(manifest.devices.map(async device => [device.key, parseStored<PushDevice>(await secureRead(device.storageKey))] as const));
  const bindings = await Promise.all(manifest.bindings.map(async id => [id, parseStored<PushStore['bindings'][string]>(await secureRead(bindingStorageKey(id)))] as const));
  if (devices.some(([, value]) => !value) || bindings.some(([, value]) => !value)) throw new Error('Push storage unavailable');
  return { devices: Object.fromEntries(devices) as PushStore['devices'], bindings: Object.fromEntries(bindings) as PushStore['bindings'] };
}
export async function loadPushStore(): Promise<PushStore> {
  await ensurePushStorage();
  return queuePush(readPushStore);
}
export async function mutatePushStore(change: (store: PushStore) => void) {
  await ensurePushStorage();
  return queuePush(async () => {
    const store = await readPushStore();
    change(store);
    await writePushStore(store);
  });
}
export async function loadPush(id: string): Promise<SavedPush | null> {
  const store = await loadPushStore();
  const binding = store.bindings[id];
  const device = binding?.deviceKey ? store.devices[binding.deviceKey] : undefined;
  return binding && device ? { ...binding, deviceId: device.deviceId, managementToken: device.managementToken, nativeToken: device.nativeToken } : null;
}
export function savePush(id: string, value: SavedPush | null) {
  return mutatePushStore(store => {
    if (!value) delete store.bindings[id];
    else {
      const key = value.deviceKey ?? value.gatewayUrl;
      store.devices[key] = { ...store.devices[key], key, gatewayUrl: value.gatewayUrl, deviceId: value.deviceId, managementToken: value.managementToken, nativeToken: value.nativeToken, appId: 'com.devitools.i7y.mobile', environment: store.devices[key]?.environment ?? '' };
      const { managementToken: _management, nativeToken: _native, deviceId: _device, ...binding } = value;
      store.bindings[id] = { ...binding, deviceKey: key };
    }
  });
}
export async function loadPushProof(): Promise<PendingPushProof | null> { return parseStored(await secureRead(pushProofKey)); }
export function savePushProof(value: PendingPushProof | null) { return secureWrite(pushProofKey, value ? JSON.stringify(value) : null); }
