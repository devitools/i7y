import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import type { PendingPushProof } from './push-proof';
import type { PushRegistration, Session } from './types';

const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const sessionKey = 'i7y.mobile.session';
const pushKey = 'i7y.mobile.push';
const pushProofKey = 'i7y.mobile.push-proof';
const preferencesKey = 'i7y.mobile.preferences';
let webSession: Session | null = null;
let sessionWrites: Promise<void> = Promise.resolve();

export interface Preferences { serverUrl: string; instanceId?: string; organizationId?: string }
export interface SavedPush extends PushRegistration { pendingRevocation?: boolean }

export async function prepareStorage() {
  if (Platform.OS === 'web') return;
  const directory = new Directory(Paths.document, 'i7y-private');
  directory.create({ intermediates: true, idempotent: true });
  const marker = new File(directory, 'installation');
  if (!marker.exists) {
    await SecureStore.deleteItemAsync(sessionKey, options);
    await savePushProof(null);
    const push = await loadPush();
    if (push) await savePush({ ...push, pendingRevocation: true });
    marker.create({ overwrite: true });
    marker.write('1');
  }
}

export async function loadPreferences(): Promise<Preferences> {
  const value = await AsyncStorage.getItem(preferencesKey);
  if (!value) return { serverUrl: '' };
  try { return JSON.parse(value); } catch { return { serverUrl: '' }; }
}
export async function savePreferences(value: Preferences) { await AsyncStorage.setItem(preferencesKey, JSON.stringify(value)); }
export async function loadSession(): Promise<Session | null> {
  if (Platform.OS === 'web') return webSession;
  const value = await SecureStore.getItemAsync(sessionKey, options);
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}
export async function saveSession(value: Session | null, current: () => boolean = () => true) {
  const write = sessionWrites.catch(() => {}).then(async () => {
    if (!current()) return;
    if (Platform.OS === 'web') { webSession = value; return; }
    if (value) await SecureStore.setItemAsync(sessionKey, JSON.stringify(value), options);
    else await SecureStore.deleteItemAsync(sessionKey, options);
  });
  sessionWrites = write;
  await write;
}
export async function loadPush(): Promise<SavedPush | null> {
  if (Platform.OS === 'web') return null;
  const value = await SecureStore.getItemAsync(pushKey, options);
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}
export async function savePush(value: SavedPush | null) {
  if (Platform.OS === 'web') return;
  if (value) await SecureStore.setItemAsync(pushKey, JSON.stringify(value), options);
  else await SecureStore.deleteItemAsync(pushKey, options);
}

export async function loadPushProof(): Promise<PendingPushProof | null> {
  if (Platform.OS === 'web') return null;
  const value = await SecureStore.getItemAsync(pushProofKey, options);
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}
export async function savePushProof(value: PendingPushProof | null) {
  if (Platform.OS === 'web') return;
  if (value) await SecureStore.setItemAsync(pushProofKey, JSON.stringify(value), options);
  else await SecureStore.deleteItemAsync(pushProofKey, options);
}
