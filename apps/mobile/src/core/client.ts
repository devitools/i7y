import type { Incident, Organization, Page, ServerInfo, Session } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class ContextChangedError extends Error {
  constructor() { super('Connection context changed'); }
}

export class AuthorizationCancelledError extends Error {
  constructor() { super('Authorization cancelled'); }
}

export class UnsupportedServerError extends Error {
  constructor() { super('This server does not support the i7y mobile protocol'); }
}

class InvalidResponseError extends Error {
  constructor(public status: number) { super('The server returned an invalid API response'); }
}

export function normalizeServerUrl(value: string, development = false): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a complete HTTPS server URL'); }
  if (url.username || url.password || url.search || url.hash || !/^\/*$/.test(url.pathname)) {
    throw new Error('Use a server origin without credentials, paths, query parameters or fragments');
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|10\.(\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(development && local && url.protocol === 'http:')) {
    throw new Error('This server must use HTTPS');
  }
  return url.origin;
}

export function validateInfo(value: ServerInfo): ServerInfo {
  if (value?.protocol_version !== 1 || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.instance_id) ||
      !Array.isArray(value.capabilities) || !['incidents', 'browser_login'].every(c => value.capabilities.includes(c))) {
    throw new UnsupportedServerError();
  }
  return value;
}

export function incidentTimestamp(value: string): number {
  const normalized = value.replace(' ', 'T');
  return Date.parse(normalized && !/(Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized + 'Z' : normalized);
}

export function incidentPhase(incident: Incident, now = Date.now()): 'open' | 'inProgress' | 'overdue' | 'resolved' {
  if (incident.status === 'resolved') return 'resolved';
  if (!incident.assignee) return 'open';
  return incidentTimestamp(incident.claim_until) > now ? 'inProgress' : 'overdue';
}

export interface ClientState { serverUrl: string; session: Session | null; organizationId: string | null }

export class I7yClient {
  private generation = 0;
  private requests = new Set<AbortController>();
  constructor(private state: () => ClientState, private fetcher: typeof fetch) {}

  invalidate() {
    this.generation++;
    for (const request of this.requests) request.abort();
    this.requests.clear();
  }

  async request<T>(path: string, options: { method?: string; body?: unknown; query?: Record<string, unknown>; public?: boolean; serverUrl?: string; signal?: AbortSignal } = {}): Promise<T> {
    const version = this.generation;
    const context = this.state();
    const origin = options.serverUrl ?? context.serverUrl;
    if (!origin || !path.startsWith('/api/') || path.startsWith('//')) throw new Error('Invalid API request');
    if (!options.public && !context.session) throw new ApiError(401, 'Sign in required');
    if (!options.public && context.session?.serverUrl !== origin) throw new ContextChangedError();
    const url = new URL(origin + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    this.requests.add(controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 15000);
    try {
      const response = await this.fetcher(url.href, {
        method: options.method ?? 'GET', signal: controller.signal, redirect: 'error', credentials: 'omit',
        headers: {
          Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(!options.public && context.session ? { Authorization: `Bearer ${context.session.token}` } : {}),
          ...(!options.public && context.organizationId ? { 'X-I7y-Organization': context.organizationId } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (version !== this.generation) throw new ContextChangedError();
      const data = response.status === 204 ? null : await response.json().catch((cause: unknown) => {
        if (version !== this.generation) throw new ContextChangedError();
        if (cause instanceof SyntaxError) throw new InvalidResponseError(response.status);
        throw cause;
      });
      if (version !== this.generation) throw new ContextChangedError();
      if (!response.ok) throw new ApiError(response.status, typeof data?.message === 'string' ? data.message : 'Request failed');
      return data as T;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      this.requests.delete(controller);
    }
  }

  async info(serverUrl?: string) {
    try { return validateInfo(await this.request<ServerInfo>('/api/i7y/mobile/v1/info', { public: true, serverUrl })); }
    catch (cause) {
      if ((cause instanceof ApiError && cause.status === 404) || (cause instanceof InvalidResponseError && [200, 404].includes(cause.status))) throw new UnsupportedServerError();
      throw cause;
    }
  }
  organizations() { return this.request<{ items: Organization[]; global_admin: boolean }>('/api/i7y/organizations'); }
  incidents(query: Record<string, unknown> = {}) { return this.request<Page<Incident>>('/api/i7y/alerts/v1/incidents', { query }); }
  incident(id: string) { return this.request<Incident>('/api/i7y/alerts/v1/incidents/' + encodeURIComponent(id)); }
  claim(id: string, claim_until: string, version: number) { return this.request<Incident>('/api/i7y/alerts/v1/incidents/' + encodeURIComponent(id) + '/claim', { method: 'POST', body: { claim_until, version } }); }
  resolve(id: string, version: number) { return this.request<Incident>('/api/i7y/alerts/v1/incidents/' + encodeURIComponent(id) + '/resolve', { method: 'POST', body: { version } }); }
  notifications(cursor = '0') { return this.request<{ items: { incident_id: string }[]; cursor: string; open_count: number }>('/api/i7y/alerts/v1/notification-events', { query: { cursor, limit: 100 } }); }
}
