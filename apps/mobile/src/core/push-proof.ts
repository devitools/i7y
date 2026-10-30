export interface PendingPushProof {
  registrationId: string;
  expiresAt: string;
  gatewayUrl: string;
  nativeToken: string;
  connectionId: string;
  serverUrl: string;
  instanceId: string;
}
export function registrationProof(data: Record<string, unknown> | undefined) {
  if (data?.kind !== 'registration_challenge' || typeof data.registration_id !== 'string' || typeof data.nonce !== 'string') return null;
  if (![data.registration_id, data.nonce].every(value => /^[A-Za-z0-9_-]{16,160}$/.test(value))) return null;
  return { registrationId: data.registration_id, nonce: data.nonce };
}
export function matchesPendingProof(pending: PendingPushProof, registrationId: string, context: { connectionId: string; serverUrl: string; instanceId: string }, gatewayUrl: string | null, now = Date.now()) {
  const expires = Date.parse(pending.expiresAt);
  return pending.registrationId === registrationId && pending.connectionId === context.connectionId && pending.serverUrl === context.serverUrl && pending.instanceId === context.instanceId && pending.gatewayUrl === gatewayUrl && Number.isFinite(expires) && expires > now;
}
