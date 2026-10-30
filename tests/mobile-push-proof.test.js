import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrationProof, matchesPendingProof } from '../apps/mobile/src/core/push-proof.ts';
const context = { connectionId: 'connection-a', serverUrl: 'https://one.example.com', instanceId: 'instance-a' };
const id = 'registration_1234567890';
const pending = { ...context, registrationId: id, expiresAt: '2026-10-29T21:00:00Z', gatewayUrl: 'https://push.example.com', nativeToken: 'private' };
const now = Date.parse('2026-10-29T20:59:00Z');
test('registration proof accepts the notification data delivered by Expo', () => {
 assert.deepEqual(registrationProof({kind:'registration_challenge',registration_id:id,nonce:'proof_1234567890123456'}), {registrationId:id,nonce:'proof_1234567890123456'});
 for (const data of [undefined, {}, {kind:'incident'}, {kind:'registration_challenge',registration_id:id,nonce:'bad nonce'}]) assert.equal(registrationProof(data),null);
});
test('resumed registration only completes for the saved installation, session and gateway before expiry', () => {
 assert.equal(matchesPendingProof(pending,id,context,pending.gatewayUrl,now),true);
 for (const key of ['connectionId','serverUrl','instanceId']) assert.equal(matchesPendingProof(pending,id,{...context,[key]:'other'},pending.gatewayUrl,now),false);
 assert.equal(matchesPendingProof(pending,'other',context,pending.gatewayUrl,now),false);
 assert.equal(matchesPendingProof(pending,id,context,'https://other.example.com',now),false);
 assert.equal(matchesPendingProof(pending,id,context,pending.gatewayUrl,Date.parse(pending.expiresAt)),false);
 assert.equal(matchesPendingProof({...pending,expiresAt:'invalid'},id,context,pending.gatewayUrl,now),false);
});
