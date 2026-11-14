import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createLoginSession, MobileConnection } from '../apps/mobile/src/core/connections.ts';
import { allowsNotification, routeIncidentNotification } from '../apps/mobile/src/core/notification-router.ts';
import { build } from 'esbuild';

const origin = 'https://push.devi.tools';
const appId = 'com.devitools.i7y.mobile';
const instance = 'installation_123456789';
const info = { instance_id: instance, capabilities: ['incidents', 'browser_login', 'push'], protocol_version: 1, push_gateway_url: origin };
function session(id) { return { connectionId: id, serverUrl: `https://${id}.example.com`, instanceId: instance, token: id + '-secret', record: { id, email: id + '@example.com' } }; }

async function harness({ legacy, aggregate, denied = false, revokeOffline = false, failManifestWrites = 0 } = {}) {
  const secure = new Map(legacy ? [['i7y.mobile.push', JSON.stringify(legacy)]] : []), plain = new Map(), calls = [], listeners = new Set(), presented = [], dismissed = [];
  if (aggregate) secure.set('i7y.mobile.push.v2', JSON.stringify(aggregate));
  let nativeToken = 'native-token', registrations = 0, bindings = 0;
  const notifications = {
    AndroidImportance: { HIGH: 4 },
    setNotificationChannelAsync: async () => {}, getPermissionsAsync: async () => ({ granted: !denied }), requestPermissionsAsync: async () => ({ granted: !denied }),
    getDevicePushTokenAsync: async () => ({ data: nativeToken }),
    addNotificationReceivedListener: callback => { listeners.add(callback); return { remove: () => listeners.delete(callback) }; },
    addNotificationResponseReceivedListener: () => ({ remove() {} }),
    getPresentedNotificationsAsync: async () => presented,
    dismissNotificationAsync: async id => { dismissed.push(id); },
  };
  const mock = {
    digest: value => createHash('sha256').update(value).digest('hex'),
    constants: { expoConfig: { extra: { pushGatewayUrl: origin, pushEnvironment: 'sandbox', buildVariant: 'production' } } },
    Platform: { OS: 'ios' }, notifications,
    asyncStorage: { getItem: async key => plain.get(key) ?? null, setItem: async (key, value) => { if (key === 'i7y.mobile.push.manifest.v3' && failManifestWrites > 0) { failManifestWrites--; throw new Error('Manifest write failed'); } plain.set(key, value); }, removeItem: async key => { plain.delete(key); } },
    secureStore: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, getItemAsync: async key => secure.get(key) ?? null, setItemAsync: async (key, value) => { secure.set(key, value); }, deleteItemAsync: async key => { secure.delete(key); } },
    fetcher: async (url, options) => {
      const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, options, body });
      if (path === '/v2/registrations') {
        registrations++;
        const id = 'registration_1234567890';
        queueMicrotask(() => { for (const listener of listeners) listener({ request: { content: { data: { kind: 'registration_challenge', registration_id: id, nonce: 'nonce_1234567890123456' } } } }); });
        return Response.json({ registration_id: id, expires_at: new Date(Date.now() + 60000).toISOString() });
      }
      if (path.endsWith('/confirm')) return Response.json({ device_id: 'shared-device', management_token: options.headers.Authorization?.slice(7) ?? 'shared-management-secret' });
      if (path === '/v2/bindings') return Response.json({ binding_id: 'binding-' + ++bindings, send_token: 'send-' + bindings });
      if (options.method === 'DELETE') return revokeOffline ? Response.json({ message: 'Unavailable' }, { status: 503 }) : new Response(null, { status: 204 });
      throw new Error('Unexpected gateway request: ' + path);
    },
  };
  const sources = {
    'expo/fetch': 'export const fetch=globalThis.__test.fetcher;',
    'expo-constants': 'export default globalThis.__test.constants;',
    'expo-localization': "export const getCalendars=()=>[{timeZone:'UTC'}];",
    'expo-file-system': 'export class Directory {create(){}}; export class File {exists=false}; export const Paths={document:"/private"};',
    'expo-notifications': Object.keys(notifications).map(name => `export const ${name}=globalThis.__test.notifications.${name};`).join('\n'),
    'expo-secure-store': Object.keys(mock.secureStore).map(name => `export const ${name}=globalThis.__test.secureStore.${name};`).join('\n'),
    'expo-crypto': 'export const randomUUID=()=>"new-connection"; export const CryptoDigestAlgorithm={SHA256:"SHA256"}; export const digestStringAsync=async(_algorithm,value)=>globalThis.__test.digest(value);',
    'react-native': 'export const Platform=globalThis.__test.Platform;',
    '@react-native-async-storage/async-storage': 'export default globalThis.__test.asyncStorage;',
    '@/locales': 'export const locale=()=>"en";',
    './config': 'export const allowLocalServers=false;',
  };
  const result = await build({ stdin: { contents: "export * from './apps/mobile/src/core/push.ts'; export * from './apps/mobile/src/core/storage.ts';", resolveDir: process.cwd(), loader: 'ts' }, write: false, bundle: true, format: 'cjs', platform: 'node', plugins: [{ name: 'mobile-native-mocks', setup(builder) { builder.onResolve({ filter: /.*/ }, args => sources[args.path] ? { path: args.path, namespace: 'mock' } : undefined); builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: sources[args.path], loader: 'js' })); } }] });
  const context = { __test: mock, module: { exports: {} }, console, URL, Response, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, __DEV__: false };
  vm.runInNewContext(result.outputFiles[0].text, context);
  const owners = new Map();
  const apiFor = user => ({ request: async (path, options) => {
    calls.push({ backend: true, path, options });
    if (path === '/api/i7y/mobile/v1/devices' && options.method === 'POST') {
      const id = options.body.connection_id;
      if (owners.has(id) && owners.get(id) !== user) throw Object.assign(new Error('Device not found'), { status: 404 });
      owners.set(id, user);
    }
    return { id: 'backend-device' };
  } });
  const api = apiFor('default');
  return { ...context.module.exports, api, apiFor, owners, secure, plain, calls, presented, dismissed, registrations: () => registrations, setEnvironment: value => { mock.constants.expoConfig.extra.pushEnvironment = value; }, setRevokeOffline: value => { revokeOffline = value; }, nativeToken: value => { nativeToken = value; } };
}

test('adding connections reuses one enrollment and individual logout preserves other bindings', async () => {
  const h = await harness();
  assert.equal(await h.enrollPush(h.api, info, session('one'), () => true), 'enabled');
  assert.equal(await h.enrollPush(h.api, info, session('two'), () => true), 'enabled');
  assert.equal(h.registrations(), 1);
  assert.equal(h.calls.filter(call => call.path === '/v2/bindings').length, 2);
  assert.equal(h.calls.filter(call => call.options.method === 'DELETE').length, 0);
  const store = await h.loadPushStore();
  assert.equal(Object.keys(store.devices).length, 1);
  assert.equal(Object.keys(store.bindings).length, 2);
  assert.equal('managementToken' in store.bindings.one, false);
  h.presented.push({ request: { identifier: 'one-notice', content: { data: { connection_id: 'one', organization_id: 'org', incident_id: 'i', event_id: 'e' } } } }, { request: { identifier: 'two-notice', content: { data: { connection_id: 'two', organization_id: 'org', incident_id: 'i', event_id: 'e' } } } });
  await h.revokePush('one');
  assert.equal(await h.loadPush('one'), null);
  assert.equal((await h.loadPush('two')).bindingId, 'binding-2');
  assert.deepEqual(h.dismissed, ['one-notice']);
  assert.deepEqual(h.calls.filter(call => call.options.method === 'DELETE').map(call => call.path), ['/v2/bindings/binding-1']);
});

test('authenticated native token rotation includes management proof at start and confirmation', async () => {
  const h = await harness();
  await h.enrollPush(h.api, info, session('one'), () => true);
  await h.enrollPush(h.api, info, session('two'), () => true);
  h.nativeToken('rotated-token');
  await h.enrollPush(h.api, info, session('one'), () => true);
  const starts = h.calls.filter(call => call.path === '/v2/registrations');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].body.device_id, 'shared-device');
  assert.equal(starts[1].body.token, 'rotated-token');
  assert.equal(starts[1].options.headers.Authorization, 'Bearer shared-management-secret');
  const confirmations = h.calls.filter(call => call.path.endsWith('/confirm'));
  assert.equal(confirmations[1].options.headers.Authorization, 'Bearer shared-management-secret');
  assert.equal((await h.loadPush('two')).bindingId, 'binding-2');
  assert.equal((await h.loadPush('two')).nativeToken, 'rotated-token');
});

test('published v1 push storage migrates and adds v2 bindings without new enrollment or revocation', async () => {
  const legacy = { gatewayUrl: 'https://i7y-push.disk.ninja', deviceId: 'legacy-device', managementToken: 'legacy-secret', nativeToken: 'native-token', connectionId: 'one', bindingId: 'legacy-binding', backendDeviceId: 'legacy-backend' };
  const h = await harness({ legacy });
  const migrated = await h.loadPush('one');
  assert.equal(migrated.bindingId, 'legacy-binding');
  assert.equal(migrated.version, 1);
  assert.equal(h.secure.has('i7y.mobile.push'), false);
  await h.enrollPush(h.api, info, session('two'), () => true);
  assert.equal(h.registrations(), 0);
  const binding = h.calls.find(call => call.path === '/v2/bindings');
  assert.equal(binding.body.device_id, 'legacy-device');
  assert.equal(binding.options.headers.Authorization, 'Bearer legacy-secret');
  assert.equal((await h.loadPush('one')).bindingId, 'legacy-binding');
  assert.equal(Object.keys((await h.loadPushStore()).devices).length, 1);
  await h.revokePush('one');
  assert.ok(h.calls.some(call => call.path === '/v1/bindings/legacy-binding'));
  assert.ok(await h.loadPush('two'));
});

test('denied notification permission sends no device credential or gateway requests', async () => {
  const h = await harness({ denied: true });
  assert.equal(await h.enrollPush(h.api, info, session('one'), () => true), 'denied');
  assert.equal(h.calls.length, 0);
});

test('concurrent connection enrollments serialize and share the native device credential', async () => {
  const h = await harness();
  await Promise.all(['one', 'two', 'three'].map(id => h.enrollPush(h.api, info, session(id), () => true)));
  assert.equal(h.registrations(), 1);
  assert.equal(Object.keys((await h.loadPushStore()).bindings).length, 3);
  assert.equal(Object.keys((await h.loadPushStore()).devices).length, 1);
  const serialized = [...h.secure.values()].join('');
  assert.equal(serialized.match(/shared-management-secret/g).length, 1);
  assert.equal(h.secure.has('i7y.mobile.push.v2'), false);
  assert.equal(h.plain.get('i7y.mobile.push.manifest.v3').includes('shared-management-secret'), false);
});


test('queued stale session writes cannot restore one signed-out profile or block another profile', async () => {
  const h = await harness();
  let current = true;
  const stale = h.saveSession('one', session('one'), () => current);
  current = false;
  await Promise.all([stale, h.saveSession('one', null), h.saveSession('two', session('two'))]);
  assert.equal(await h.loadSession('one'), null);
  assert.equal((await h.loadSession('two')).token, 'two-secret');
  assert.equal(h.secure.has('i7y.mobile.session.two'), true);
});

test('an offline individual revocation stays pending and later retries without touching another binding', async () => {
  const h = await harness({ revokeOffline: true });
  await h.enrollPush(h.api, info, session('one'), () => true);
  await h.enrollPush(h.api, info, session('two'), () => true);
  assert.equal(await h.revokePush('one'), false);
  assert.equal((await h.loadPush('one')).pendingRevocation, true);
  assert.equal((await h.loadPush('two')).bindingId, 'binding-2');
  h.setRevokeOffline(false);
  assert.equal(await h.revokePush('one'), true);
  assert.equal(await h.loadPush('one'), null);
  assert.equal((await h.loadPush('two')).bindingId, 'binding-2');
});


test('changing native push environment reuses its own device credential and replaces only that connection binding', async () => {
  const h = await harness();
  await h.enrollPush(h.api, info, session('one'), () => true);
  await h.enrollPush(h.api, info, session('two'), () => true);
  h.setEnvironment('production');
  await h.enrollPush(h.api, info, session('one'), () => true);
  assert.equal(h.registrations(), 2);
  assert.equal((await h.loadPush('one')).bindingId, 'binding-3');
  assert.equal((await h.loadPush('two')).bindingId, 'binding-2');
  assert.equal(Object.keys((await h.loadPushStore()).devices).length, 2);
  h.setEnvironment('sandbox');
  await h.enrollPush(h.api, info, session('one'), () => true);
  assert.equal(h.registrations(), 2);
  assert.equal((await h.loadPush('one')).bindingId, 'binding-4');
  assert.ok((await h.loadPush('one')).deviceKey.includes('sandbox'));
  assert.equal((await h.loadPush('two')).bindingId, 'binding-2');
});


test('account replacement on one saved profile uses a new remote binding identity and rejects old account notifications', async () => {
  const h = await harness({ revokeOffline: true });
  const profile = { id: 'local-profile', name: 'Shared server', serverUrl: 'https://one.example.com', instanceId: instance };
  const a = createLoginSession(profile, 'token-a', { id: 'account-a', email: 'a@example.com' }, () => 'remote-a');
  const b = createLoginSession(profile, 'token-b', { id: 'account-b', email: 'b@example.com' }, () => 'remote-b');
  const connection = new MobileConnection(profile, async () => { throw new Error('Unexpected stale notification request'); });
  connection.session = a;
  connection.organizations = [{ id: 'org', name: 'Organization', role: 'editor' }];
  await h.enrollPush(h.apiFor('account-a'), info, a, connection.current(a));
  connection.clear();
  assert.equal(await h.revokePush(a.connectionId), false);
  await assert.rejects(h.apiFor('account-b').request('/api/i7y/mobile/v1/devices', { method: 'POST', body: { connection_id: a.connectionId } }), /Device not found/);
  connection.session = b;
  connection.organizations = [{ id: 'org', name: 'Organization', role: 'editor' }];
  await h.saveSession(profile.id, b);
  await h.enrollPush(h.apiFor('account-b'), info, b, connection.current(b));
  assert.equal(h.owners.get('remote-a'), 'account-a');
  assert.equal(h.owners.get('remote-b'), 'account-b');
  assert.equal((await h.loadSession(profile.id)).connectionId, 'remote-b');
  assert.equal((await h.loadPush('remote-a')).pendingRevocation, true);
  assert.equal((await h.loadPush('remote-b')).pendingRevocation, undefined);
  const connections = new Map([[profile.id, connection]]);
  const old = { connection_id: 'remote-a', organization_id: 'org', incident_id: 'same', event_id: 'same-event' };
  assert.equal(allowsNotification(old, connections), false);
  assert.equal(await routeIncidentNotification(old, connections, async () => { throw new Error('Must not refresh account A as account B'); }), null);
  assert.equal(allowsNotification({ ...old, connection_id: 'remote-b' }, connections), true);
});

test('split secure storage scales to many bindings without a growing credential value', async () => {
  const h = await harness();
  for (let index = 0; index < 32; index++) await h.enrollPush(h.api, info, session('connection-' + index), () => true);
  const store = await h.loadPushStore();
  assert.equal(Object.keys(store.devices).length, 1);
  assert.equal(Object.keys(store.bindings).length, 32);
  assert.equal([...h.secure.keys()].filter(key => key.startsWith('i7y.mobile.push-binding.')).length, 32);
  assert.equal([...h.secure.keys()].filter(key => key.startsWith('i7y.mobile.push-device.')).length, 1);
  assert.ok([...h.secure.values()].every(value => Buffer.byteLength(value, 'utf8') < 2048));
  const manifest = h.plain.get('i7y.mobile.push.manifest.v3');
  assert.equal(manifest.includes('shared-management-secret'), false);
  assert.equal(manifest.includes('native-token'), false);
});

test('the intermediate aggregate push store migrates durably into device and binding values', async () => {
  const key = JSON.stringify([origin, appId, 'sandbox']);
  const device = { key, gatewayUrl: origin, deviceId: 'old-device', managementToken: 'old-management', nativeToken: 'native-token', environment: 'sandbox', appId };
  const aggregate = { devices: { [key]: device }, bindings: { one: { gatewayUrl: origin, bindingId: 'existing-binding', connectionId: 'one', version: 2, deviceKey: key, backendDeviceId: 'existing-backend' } } };
  const h = await harness({ aggregate });
  assert.equal((await h.loadPush('one')).bindingId, 'existing-binding');
  assert.equal((await h.loadPush('one')).managementToken, 'old-management');
  assert.equal(h.secure.has('i7y.mobile.push.v2'), false);
  assert.equal(h.plain.has('i7y.mobile.push.manifest.v3'), true);
});


test('failed split-store migration retains legacy credentials until the manifest is durable and retries safely', async () => {
  const legacy = { gatewayUrl: origin, deviceId: 'legacy-device', managementToken: 'legacy-secret', nativeToken: 'native-token', connectionId: 'one', bindingId: 'legacy-binding' };
  const h = await harness({ legacy, failManifestWrites: 1 });
  await assert.rejects(h.loadPushStore(), /Manifest write failed/);
  assert.equal(h.secure.has('i7y.mobile.push'), true);
  assert.equal(h.plain.has('i7y.mobile.push.manifest.v3'), false);
  assert.equal((await h.loadPush('one')).bindingId, 'legacy-binding');
  assert.equal(h.secure.has('i7y.mobile.push'), false);
  assert.equal(h.plain.has('i7y.mobile.push.manifest.v3'), true);
  assert.equal([...h.secure.values()].join('').match(/legacy-secret/g).length, 1);
});


test('concurrent exported push saves and removals are atomic across login identities on fresh storage', async () => {
  const h = await harness();
  const value = id => ({ gatewayUrl: origin, deviceId: 'shared-device', managementToken: 'shared-management-secret', nativeToken: 'native-token', bindingId: 'binding-' + id, connectionId: id, version: 2, deviceKey: 'shared-device-key' });
  await Promise.all([h.savePush('a', value('a')), h.savePush('b', value('b'))]);
  assert.deepEqual(Object.keys((await h.loadPushStore()).bindings).sort(), ['a', 'b']);
  await Promise.all([h.savePush('a', null), h.savePush('c', value('c'))]);
  assert.deepEqual(Object.keys((await h.loadPushStore()).bindings).sort(), ['b', 'c']);
  assert.equal((await h.loadPush('b')).bindingId, 'binding-b');
  assert.equal((await h.loadPush('c')).bindingId, 'binding-c');
});
