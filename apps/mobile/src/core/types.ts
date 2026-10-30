export interface ServerInfo {
  instance_id: string;
  protocol_version: number;
  capabilities: string[];
  push_gateway_url?: string;
}

export interface User {
  id: string;
  email: string;
  name?: string;
  global_admin?: boolean;
}

export interface Session {
  token: string;
  record: User;
  connectionId: string;
  serverUrl: string;
  instanceId: string;
}

export interface Organization {
  id: string;
  name: string;
  role: 'reader' | 'editor' | 'admin';
}

export interface Incident {
  id: string;
  title: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'resolved';
  origin: string;
  resource_name: string;
  resource_id: string;
  opened_at: string;
  resolved_at: string;
  resolution_reason: string;
  assignee: string;
  claim_until: string;
  version: number;
  evidence: Record<string, unknown>;
  events?: { id: string; kind: string; actor: string; occurred_at: string; data: Record<string, unknown> }[];
}

export interface Page<T> {
  items: T[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
}

export type PushStatus = 'disabled' | 'unconfigured' | 'denied' | 'registering' | 'enabled' | 'unavailable' | 'pending-revocation';

export interface PushRegistration {
  gatewayUrl: string;
  deviceId: string;
  managementToken: string;
  bindingId: string;
  connectionId: string;
  nativeToken: string;
  backendDeviceId?: string;
}

export interface IncidentNotification {
  connection_id: string;
  organization_id: string;
  incident_id: string;
  event_id: string;
}
