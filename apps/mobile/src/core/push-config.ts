import { normalizeServerUrl } from './client';
import type { ServerInfo } from './types';

export const canonicalPushGateway = 'https://push.devi.tools';
export const legacyPushGateway = 'https://i7y-push.disk.ninja';
export function canonicalGateway(value: string) { return value === legacyPushGateway ? canonicalPushGateway : value; }
export function selectGateway(info: ServerInfo, configured: unknown, development = false): string | null {
  if (typeof configured !== 'string' || !configured || !info.capabilities.includes('push')) return null;
  let expected: string;
  try { expected = normalizeServerUrl(configured, development); } catch { return null; }
  if (![canonicalPushGateway, legacyPushGateway].includes(expected)) {
    if (!development) return null;
    try { normalizeServerUrl(expected.replace(/^https:/, 'http:'), true); } catch { return null; }
  }
  const advertised = [...(Array.isArray(info.push_gateway_urls) ? info.push_gateway_urls : []), info.push_gateway_url].filter((value): value is string => typeof value === 'string');
  if (advertised.includes(expected)) return expected;
  return advertised.find(value => [canonicalPushGateway, legacyPushGateway].includes(value) && canonicalGateway(value) === canonicalGateway(expected)) ?? null;
}
