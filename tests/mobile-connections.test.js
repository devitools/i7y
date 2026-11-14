import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateConnections, connectionSessionKey, connectionPreferencesKey } from '../apps/mobile/src/core/connection-storage.ts';
import { MobileConnection, createLoginSession, sessionMatchesProfile, resolveIncidentSource, sourceKey } from '../apps/mobile/src/core/connections.ts';
import { inboxCursor, loadInboxPage, incidentIdentity } from '../apps/mobile/src/core/inbox.ts';
import { allowsNotification, parseIncidentNotification, routeIncidentNotification } from '../apps/mobile/src/core/notification-router.ts';
import { selectGateway } from '../apps/mobile/src/core/push-config.ts';

const instance = 'installation_123456789';
const organization = { id: 'org', name: 'Organization', role: 'editor' };
function connection(id, fetcher, organizations = [organization]) {
  const value = new MobileConnection({ id, name: id, serverUrl: `https://${id}.example.com`, instanceId: instance }, fetcher);
  value.session = { token: id + '-secret', connectionId: id, serverUrl: value.profile.serverUrl, instanceId: instance, record: { id: id + '-user', email: id + '@example.com' } };
  value.info = { instance_id: instance, protocol_version: 1, capabilities: ['incidents', 'browser_login', 'inbox'] };
  value.organizations = organizations;
  return value;
}
const incident = (id, day, organizationId = 'org', created = '') => ({ id, organization_id: organizationId, title: id, opened_at: `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`, created });
function page(items, index = 1, totalPages = 1, totalItems = items.length) { return Response.json({ items, page: index, totalPages, totalItems, perPage: 2 }); }
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }

test('legacy preferences and secure session migrate without changing connection or login', async () => {
  const session = { token: 'secret', connectionId: 'existing-connection', serverUrl: 'https://one.example.com', instanceId: instance, record: { id: 'user', email: 'u@example.com' } };
  const plain = new Map([['i7y.mobile.preferences', JSON.stringify({ serverUrl: session.serverUrl, instanceId: instance, organizationId: 'org' })]]);
  const secure = new Map([['i7y.mobile.session', JSON.stringify(session)]]);
  const storage = { read: async key => plain.get(key) ?? null, write: async (key, value) => { if (value === null) plain.delete(key); else plain.set(key, value); }, secureRead: async key => secure.get(key) ?? null, secureWrite: async (key, value) => { if (value === null) secure.delete(key); else secure.set(key, value); } };
  const saved = await migrateConnections(storage, () => 'unexpected-new-id');
  assert.equal(saved.activeId, session.connectionId);
  assert.equal(saved.profiles[0].organizationId, 'org');
  assert.deepEqual(JSON.parse(secure.get(connectionSessionKey(session.connectionId))), session);
  assert.equal(secure.has('i7y.mobile.session'), false);
  assert.equal(JSON.stringify([...plain.values()]).includes('secret'), false);
  assert.deepEqual(await migrateConnections(storage, () => 'another-id'), saved);
  assert.equal(plain.has(connectionPreferencesKey), true);
});

test('failed migration leaves legacy session recoverable until new storage is durable', async () => {
  const legacy = { token: 'secret', connectionId: 'old', serverUrl: 'https://one.example.com', instanceId: instance };
  const secure = new Map([['i7y.mobile.session', JSON.stringify(legacy)]]);
  const storage = { read: async () => null, secureRead: async key => secure.get(key) ?? null, secureWrite: async (key, value) => { if (value === null) secure.delete(key); else secure.set(key, value); }, write: async () => { throw new Error('disk full'); } };
  await assert.rejects(migrateConnections(storage, () => 'new'), /disk full/);
  assert.deepEqual(JSON.parse(secure.get('i7y.mobile.session')), legacy);
  assert.deepEqual(JSON.parse(secure.get(connectionSessionKey('old'))), legacy);
});

test('sign-out invalidates only its connection and all organization clients retain fixed origins', async () => {
  const waiting = deferred(), calls = [];
  const one = connection('one', async (url, options) => { calls.push({ url, options }); return waiting.promise; });
  const two = connection('two', async (url, options) => { calls.push({ url, options }); return page([]); });
  const request = one.api('org').incident('same-id');
  one.clear();
  assert.equal(calls[0].options.signal.aborted, true);
  await two.api('other-org').claim('same-id', '2026-11-14T00:00:00Z', 4);
  waiting.resolve(page([]));
  await assert.rejects(request, /context changed/i);
  assert.equal(two.session.token, 'two-secret');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer two-secret');
  assert.equal(calls[1].options.headers['X-I7y-Organization'], 'other-org');
  assert.equal(new URL(calls[1].url).host, 'two.example.com');
  assert.notEqual(sourceKey('one', 'org', 'same-id'), sourceKey('two', 'org', 'same-id'));
});

test('unified paging refills source buffers before merging and preserves identical IDs', async () => {
  const calls = [];
  const one = connection('one', async url => { const n = Number(new URL(url).searchParams.get('page')); calls.push(['one', n]); return n === 1 ? page([incident('same', 13), incident('a', 11)], 1, 2, 3) : page([incident('b', 9)], 2, 2, 3); });
  const two = connection('two', async url => { const n = Number(new URL(url).searchParams.get('page')); calls.push(['two', n]); return n === 1 ? page([incident('same', 12), incident('c', 10)], 1, 2, 3) : page([incident('d', 8)], 2, 2, 3); });
  const first = await loadInboxPage(inboxCursor([one, two]), {}, 2);
  const second = await loadInboxPage(first.next, {}, 2);
  const third = await loadInboxPage(second.next, {}, 2);
  const items = [...first.items, ...second.items, ...third.items];
  assert.deepEqual(items.map(item => [item.connectionId, item.id]), [['one', 'same'], ['two', 'same'], ['one', 'a'], ['two', 'c'], ['one', 'b'], ['two', 'd']]);
  assert.equal(new Set(items.map(incidentIdentity)).size, 6);
  assert.equal(third.next, undefined);
  assert.deepEqual(calls.sort(), [['one', 1], ['one', 2], ['two', 1], ['two', 2]]);
});

test('ordering uses opened time, creation time, and descending ID across backends', async () => {
  const one = connection('one', async () => page([incident('a', 13, 'org', '2026-11-13T01:00:00Z'), incident('z', 12, 'org', '2026-11-13T02:00:00Z')]));
  const two = connection('two', async () => page([incident('z', 13, 'org', '2026-11-13T01:00:00Z'), incident('newer-created', 13, 'org', '2026-11-13T02:00:00Z')]));
  const result = await loadInboxPage(inboxCursor([one, two]), {}, 10);
  assert.deepEqual(result.items.map(item => item.id), ['newer-created', 'z', 'a', 'z']);
});

test('only 404 falls back to all authorized organizations with independent headers', async () => {
  for (const status of [404, 401, 403, 500]) {
    const calls = [];
    const one = connection('one', async (url, options) => {
      calls.push({ url, headers: options.headers });
      if (new URL(url).pathname.endsWith('/inbox')) return Response.json({ message: 'Unavailable' }, { status });
      return page([incident('same', 13, options.headers['X-I7y-Organization'])]);
    }, [organization, { ...organization, id: 'other' }]);
    const result = await loadInboxPage(inboxCursor([one]), {}, 10);
    if (status === 404) {
      assert.equal(result.items.length, 2);
      assert.equal(new Set(result.items.map(incidentIdentity)).size, 2);
      assert.deepEqual(calls.slice(1).map(call => call.headers['X-I7y-Organization']).sort(), ['org', 'other']);
    } else { assert.equal(result.items.length, 0); assert.deepEqual(result.failures, ['one']); assert.equal(calls.length, 1); }
  }
});

test('an unavailable backend yields a partial result while another continues paging', async () => {
  const failed = connection('failed', async () => { throw new TypeError('Offline'); });
  const healthy = connection('healthy', async url => {
    const n = Number(new URL(url).searchParams.get('page'));
    return page([incident('i' + n, 14 - n)], n, 2, 2);
  });
  const first = await loadInboxPage(inboxCursor([failed, healthy]), {}, 1);
  assert.deepEqual(first.failures, ['failed']);
  assert.equal(first.items[0].connectionId, 'healthy');
  const second = await loadInboxPage(first.next, {}, 1);
  assert.equal(second.items[0].id, 'i2');
});

test('notification taps route to an inactive backend only after live membership and incident checks', async () => {
  const calls = [];
  const active = connection('active', async () => { throw new Error('wrong backend'); });
  const inactive = connection('inactive', async (url, options) => { calls.push({ url, options }); return Response.json(incident('same', 13)); });
  const connections = new Map([['active', active], ['inactive', inactive]]);
  const data = parseIncidentNotification({ connection_id: 'inactive', organization_id: 'org', incident_id: 'same', event_id: 'event' });
  let refreshed = false;
  const params = await routeIncidentNotification(data, connections, async value => { assert.equal(value, inactive); refreshed = true; });
  assert.equal(refreshed, true);
  assert.deepEqual(params, { id: 'same', connectionId: 'inactive', loginId: 'inactive', organizationId: 'org' });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer inactive-secret');
  assert.equal(calls[0].options.headers['X-I7y-Organization'], 'org');
  assert.equal(new URL(calls[0].url).host, 'inactive.example.com');
  inactive.organizations = [];
  assert.equal(allowsNotification(data, connections), false);
  assert.equal(await routeIncidentNotification(data, connections, async () => {}), null);
  assert.equal(calls.length, 1);
});

test('removed sessions and membership revocation block notification fetches and late navigation', async () => {
  const pending = deferred(), calls = [];
  const one = connection('one', async url => { calls.push(url); return pending.promise; });
  const connections = new Map([['one', one]]), data = { connection_id: 'one', organization_id: 'org', incident_id: 'same', event_id: 'event' };
  const route = routeIncidentNotification(data, connections, async () => {});
  await Promise.resolve();
  one.clear();
  pending.resolve(Response.json(incident('same', 13)));
  await assert.rejects(route, /context changed/i);
  assert.equal(await routeIncidentNotification(data, connections, async () => { throw new Error('must not refresh signed out'); }), null);
  assert.equal(calls.length, 1);
});

test('gateway trust accepts canonical and compatible alias, never an advertised arbitrary destination', () => {
  const info = { capabilities: ['push'], push_gateway_url: 'https://i7y-push.disk.ninja' };
  assert.equal(selectGateway(info, 'https://push.devi.tools'), 'https://i7y-push.disk.ninja');
  assert.equal(selectGateway({ ...info, push_gateway_urls: ['https://push.devi.tools', info.push_gateway_url] }, 'https://push.devi.tools'), 'https://push.devi.tools');
  assert.equal(selectGateway({ ...info, push_gateway_url: 'https://evil.example.com' }, 'https://push.devi.tools'), null);
  assert.equal(selectGateway({ ...info, push_gateway_url: 'https://evil.example.com' }, 'https://evil.example.com'), null);
  assert.equal(selectGateway({ ...info, push_gateway_url: 'https://evil.example.com' }, 'https://evil.example.com', true), null);
  assert.equal(selectGateway({ ...info, push_gateway_url: 'http://127.0.0.1:8787' }, 'http://127.0.0.1:8787', true), 'http://127.0.0.1:8787');
});


test('authorized inbox membership metadata includes newly granted organizations without a settings switch', async () => {
  const one = connection('one', async url => new URL(url).pathname === '/api/i7y/organizations' ? Response.json({ items: [{ id: 'new-org', name: 'New organization', role: 'editor' }], global_admin: false }) : page([{ ...incident('new-incident', 13, 'new-org'), organization_name: 'New organization', organization_role: 'editor' }]), []);
  await assert.rejects(loadInboxPage(inboxCursor([one]), {}, 10), /context changed/i);
  const result = await loadInboxPage(inboxCursor([one]), {}, 10);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].organizationId, 'new-org');
  assert.deepEqual(one.organizations, [{ id: 'new-org', name: 'New organization', role: 'editor' }]);
});


test('local profiles and per-login remote identities remain independent through restore and same-user refresh', async () => {
  const profile = { id: 'stable-profile', name: 'Server', serverUrl: 'https://server.example.com', instanceId: instance };
  const first = createLoginSession(profile, 'first-token', { id: 'first-user', email: 'a@example.com' }, () => 'first-login');
  const second = createLoginSession(profile, 'second-token', { id: 'second-user', email: 'b@example.com' }, () => 'second-login');
  assert.notEqual(first.connectionId, second.connectionId);
  assert.notEqual(second.connectionId, profile.id);
  assert.equal(sessionMatchesProfile(profile, second), true);
  assert.equal(sessionMatchesProfile({ ...profile, serverUrl: 'https://other.example.com' }, second), false);
  const refreshed = { ...second, token: 'refreshed-token' };
  assert.equal(refreshed.connectionId, second.connectionId);
  const target = connection('target', async () => Response.json({ id: 'same' }));
  target.profile = profile;
  target.session = refreshed;
  const connections = new Map([[profile.id, target]]);
  const params = await routeIncidentNotification({ connection_id: second.connectionId, organization_id: 'org', incident_id: 'same', event_id: 'event' }, connections, async () => {});
  assert.deepEqual(params, { id: 'same', connectionId: profile.id, loginId: second.connectionId, organizationId: 'org' });
});


test('a validated notification route cannot resolve after the same profile changes accounts', async () => {
  const target = connection('profile', async () => Response.json(incident('same', 13)));
  target.session = { ...target.session, connectionId: 'login-a' };
  const connections = new Map([[target.profile.id, target]]);
  const params = await routeIncidentNotification({ connection_id: 'login-a', organization_id: 'org', incident_id: 'same', event_id: 'event' }, connections, async () => {});
  assert.equal(params.loginId, 'login-a');
  const sourceA = resolveIncidentSource(connections, params.connectionId, params.loginId, params.organizationId);
  assert.equal(sourceA.session.connectionId, 'login-a');
  target.clear();
  target.session = createLoginSession(target.profile, 'token-b', { id: 'account-b', email: 'b@example.com' }, () => 'login-b');
  target.organizations = [organization];
  assert.equal(resolveIncidentSource(connections, params.connectionId, params.loginId, params.organizationId), null);
  assert.equal(resolveIncidentSource(connections, params.connectionId, '', params.organizationId), null);
  assert.equal(resolveIncidentSource(connections, params.connectionId, 'login-b', params.organizationId).session.record.id, 'account-b');
});

test('a source API captured under account A rejects instead of sending account B credentials', async () => {
  const calls = [];
  const target = connection('profile', async (url, options) => { calls.push({ url, options }); return Response.json(incident('same', 13)); });
  target.session = { ...target.session, connectionId: 'login-a' };
  const connections = new Map([[target.profile.id, target]]);
  const sourceA = resolveIncidentSource(connections, target.profile.id, 'login-a', 'org');
  target.clear();
  target.session = createLoginSession(target.profile, 'token-b', { id: 'account-b', email: 'b@example.com' }, () => 'login-b');
  target.organizations = [organization];
  await assert.rejects(sourceA.api.resolve('same', 1), /context changed/i);
  assert.equal(calls.length, 0);
  await resolveIncidentSource(connections, target.profile.id, 'login-b', 'org').api.resolve('same', 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-b');
});

test('a bound source rejects a late response even if a session is replaced without explicit invalidation', async () => {
  const waiting = deferred();
  let parsed = false;
  const target = connection('profile', async () => waiting.promise);
  target.session = { ...target.session, connectionId: 'login-a' };
  const sourceA = resolveIncidentSource(new Map([[target.profile.id, target]]), target.profile.id, 'login-a', 'org');
  const request = sourceA.api.incident('same');
  target.session = createLoginSession(target.profile, 'token-b', { id: 'account-b', email: 'b@example.com' }, () => 'login-b');
  waiting.resolve({ status: 200, ok: true, json: async () => { parsed = true; return incident('a-private', 13); } });
  await assert.rejects(request, /context changed/i);
  assert.equal(parsed, false);
});

test('a bound source also rejects account replacement while response JSON is parsing', async () => {
  const parsing = deferred(), entered = deferred();
  const target = connection('profile', async () => ({ status: 200, ok: true, json: () => { entered.resolve(); return parsing.promise; } }));
  target.session = { ...target.session, connectionId: 'login-a' };
  const sourceA = resolveIncidentSource(new Map([[target.profile.id, target]]), target.profile.id, 'login-a', 'org');
  const request = sourceA.api.incident('same');
  await entered.promise;
  target.session = createLoginSession(target.profile, 'token-b', { id: 'account-b', email: 'b@example.com' }, () => 'login-b');
  parsing.resolve(incident('a-private', 13));
  await assert.rejects(request, /context changed/i);
});

test('an inbox next cursor cannot return account A buffered rows after profile replacement', async () => {
  const calls = [];
  const target = connection('profile', async (_url, options) => {
    calls.push(options.headers.Authorization);
    return options.headers.Authorization === 'Bearer token-b' ? page([incident('b-visible', 13)]) : page([incident('a-visible', 13), incident('a-private-buffered', 12)]);
  });
  target.session = { ...target.session, connectionId: 'login-a' };
  const first = await loadInboxPage(inboxCursor([target]), {}, 1);
  assert.equal(first.items[0].loginId, 'login-a');
  assert.ok(first.next);
  target.clear();
  target.session = createLoginSession(target.profile, 'token-b', { id: 'account-b', email: 'b@example.com' }, () => 'login-b');
  target.organizations = [organization];
  await assert.rejects(loadInboxPage(first.next, {}, 1), /context changed/i);
  assert.equal(calls.length, 1);
  const fresh = await loadInboxPage(inboxCursor([target]), {}, 1);
  assert.equal(fresh.items[0].id, 'b-visible');
  assert.equal(fresh.items[0].loginId, 'login-b');
  assert.notEqual(incidentIdentity({ ...first.items[0], id: 'same' }), incidentIdentity({ ...fresh.items[0], id: 'same' }));
});


test('inbox row roles cannot elevate the authoritative membership used by incident actions', async () => {
  const target = connection('profile', async () => page([{ ...incident('same', 13), organization_role: 'admin' }]), [{ ...organization, role: 'reader' }]);
  const result = await loadInboxPage(inboxCursor([target]), {}, 1);
  const row = result.items[0];
  const source = resolveIncidentSource(new Map([[target.profile.id, target]]), row.connectionId, row.loginId, row.organizationId);
  assert.equal(source.organization.role, 'reader');
});


test('an authoritative empty membership refresh discards unknown inbox rows without restoring row hints', async () => {
  const target = connection('profile', async url => new URL(url).pathname === '/api/i7y/organizations' ? Response.json({ items: [], global_admin: false }) : page([{ ...incident('stale-private-incident', 13, 'revoked-org'), organization_role: 'admin' }]), []);
  const loginId = target.session.connectionId;
  const result = await loadInboxPage(inboxCursor([target]), {}, 30);
  assert.deepEqual(result.items, []);
  assert.deepEqual(target.organizations, []);
  assert.equal(resolveIncidentSource(new Map([[target.profile.id, target]]), target.profile.id, loginId, 'revoked-org'), null);
});

test('revoked memberships invalidate buffered pages and captured APIs without replacing the login', async () => {
  const calls = [];
  const target = connection('profile', async url => { calls.push(url); return page([incident('visible', 13), incident('private-buffered', 12)]); });
  const connections = new Map([[target.profile.id, target]]), login = target.session;
  const bound = resolveIncidentSource(connections, target.profile.id, login.connectionId, 'org');
  const first = await loadInboxPage(inboxCursor([target]), {}, 1);
  const revision = target.membershipRevision;
  target.replaceOrganizations([]);
  assert.notEqual(target.membershipRevision, revision);
  assert.equal(target.session, login);
  await assert.rejects(loadInboxPage(first.next, {}, 1), /context changed/i);
  await assert.rejects(bound.api.resolve('same', 1), /context changed/i);
  assert.equal(calls.length, 1);
  assert.equal(resolveIncidentSource(connections, target.profile.id, login.connectionId, 'org'), null);
});

test('a role revision invalidates old buffers while a fresh source retains authorized reader access', async () => {
  const target = connection('profile', async () => page([incident('visible', 13), incident('buffered', 12)]));
  const first = await loadInboxPage(inboxCursor([target]), {}, 1);
  const source = resolveIncidentSource(new Map([[target.profile.id, target]]), target.profile.id, target.session.connectionId, 'org');
  target.replaceOrganizations([{ ...organization, role: 'reader' }]);
  await assert.rejects(loadInboxPage(first.next, {}, 1), /context changed/i);
  await assert.rejects(source.api.resolve('visible', 1), /context changed/i);
  const fresh = resolveIncidentSource(new Map([[target.profile.id, target]]), target.profile.id, target.session.connectionId, 'org');
  assert.equal(fresh.organization.role, 'reader');
  assert.equal((await loadInboxPage(inboxCursor([target]), {}, 1)).items[0].id, 'visible');
});

test('membership revocation while an inbox response is pending prevents publishing that response', async () => {
  const pending = deferred();
  const target = connection('profile', async () => pending.promise);
  const request = loadInboxPage(inboxCursor([target]), {}, 1);
  target.organizations = [];
  pending.resolve(page([incident('late-private', 13)]));
  await assert.rejects(request, /context changed/i);
});
