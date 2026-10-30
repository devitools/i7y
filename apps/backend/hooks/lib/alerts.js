function time(value) {
  if (typeof value === 'number') return value
  if (!value) return NaN
  const text = String(value).replace(' ', 'T')
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(text) ? text : text + 'Z')
}
function instant(now) { return now === undefined ? Date.now() : now }
function iso(now) { return new Date(now).toISOString() }
function string(record, key) { return record.getString(key) || '' }
function number(record, key) { return Number(record.get(key)) || 0 }
function boolean(record, key) { return record.getBool(key) }
function json(record, key) {
  try { return JSON.parse(record.getString(key)) || {} } catch (_) { return {} }
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function rows(app, table, filter, params, sort) {
  return app.findRecordsByFilter(table, filter || '', sort || '', 0, 0, params || {})
}
function create(app, table, values) {
  const record = new Record(app.findCollectionByNameOrId(table))
  assign(record, values)
  app.save(record)
  return record
}
function assign(record, values) { for (const key in values) record.set(key, values[key]) }
function conflict(message) { const error = new Error(message); error.code = 409; throw error }
function bounded(value, fallback, minimum, maximum, label) {
  const result = value === undefined ? fallback : value
  if (typeof result !== 'number' || !Number.isFinite(result) || !Number.isInteger(result) || result < minimum || result > maximum) throw new Error('Invalid ' + label)
  return result
}
function text(value, label, maximum, required) {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) throw new Error('Invalid ' + label)
  return value.trim()
}
function catalog() {
  const numeric = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne']
  return [
    { id: 'host.cpu_percent', label: 'hostCpu', target_type: 'server', unit: '%', operators: numeric, supports_critical_value: true },
    { id: 'host.memory_percent', label: 'hostMemory', target_type: 'server', unit: '%', operators: numeric, supports_critical_value: true },
    { id: 'host.disk_percent', label: 'hostDisk', target_type: 'server', unit: '%', operators: numeric, supports_critical_value: true },
    { id: 'server.no_communication_seconds', label: 'noCommunication', target_type: 'server', unit: 'seconds', operators: ['gt', 'gte'] },
    { id: 'container.cpu_percent', label: 'containerCpu', target_type: 'container', unit: '%', operators: numeric },
    { id: 'container.memory_percent', label: 'containerMemory', target_type: 'container', unit: '%', operators: numeric },
    { id: 'container.state', label: 'containerState', target_type: 'container', unit: 'state', operators: ['eq', 'ne'], values: ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead', 'missing'] },
    { id: 'container.health', label: 'containerHealth', target_type: 'container', unit: 'state', operators: ['eq', 'ne'], values: ['none', 'starting', 'healthy', 'unhealthy'] }
  ]
}
function normalizeRule(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid rule')
  const condition = body.condition || {}
  const metric = catalog().find(item => item.id === condition.metric)
  if (!metric) throw new Error('Invalid metric')
  const operator = condition.operator || (metric.id === 'server.no_communication_seconds' ? 'gte' : 'gt')
  if (!metric.operators.includes(operator)) throw new Error('Invalid operator')
  const value = condition.value === undefined && metric.id === 'server.no_communication_seconds' ? 900 : condition.value
  if (metric.values ? !metric.values.includes(value) : typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid condition value')
  if (metric.id === 'server.no_communication_seconds' && value < 1) throw new Error('Invalid communication threshold')
  const scope = body.scope_type
  if (!['workspace', 'server', 'container'].includes(scope) || (scope === 'container' && metric.target_type !== 'container')) throw new Error('Invalid scope')
  if (body.target_type !== undefined && body.target_type !== metric.target_type) throw new Error('Metric does not match target type')
  const normalized = {
    name: text(body.name, 'name', 240, true), severity: body.severity === undefined ? 'warning' : body.severity,
    scope_type: scope, scope_id: text(body.scope_id, 'scope', 100, true), target_type: metric.target_type,
    condition: { metric: metric.id, operator, value }, duration_seconds: bounded(body.duration_seconds, 0, 0, 604800, 'duration'),
    reminder_seconds: bounded(body.reminder_seconds, 900, 60, 604800, 'reminder interval'),
    enabled: body.enabled === undefined ? true : body.enabled
  }
  if (!['info', 'warning', 'critical'].includes(normalized.severity) || typeof normalized.enabled !== 'boolean') throw new Error('Invalid severity or activation')
  if (condition.critical_value !== undefined) {
    if (!metric.supports_critical_value || !['gt', 'gte'].includes(operator) || normalized.severity !== 'warning' || typeof condition.critical_value !== 'number' || !Number.isFinite(condition.critical_value) || condition.critical_value <= value || condition.critical_value > 100) throw new Error('Invalid critical threshold')
    normalized.condition.critical_value = condition.critical_value
  }
  if (metric.id === 'host.disk_percent') normalized.condition.disk_path = condition.disk_path === undefined ? '*' : text(condition.disk_path, 'disk path', 1024, true)
  return normalized
}
function inventory(app, org) {
  const workspaces = rows(app, 'workspaces').filter(record => string(record, 'organization') === org)
  const workspaceIds = new Set(workspaces.map(record => record.id))
  const servers = rows(app, 'servers').filter(record => workspaceIds.has(string(record, 'workspace')))
  const serverMap = {}; for (const record of servers) serverMap[record.id] = record
  const projects = rows(app, 'projects').filter(record => !!serverMap[string(record, 'server')])
  const projectMap = {}; for (const record of projects) projectMap[record.id] = record
  const containers = rows(app, 'containers').filter(record => !!projectMap[string(record, 'project')])
  const targets = servers.map(record => ({ resource_type: 'server', resource_id: record.id, resource_name: string(record, 'name'), server_id: record.id, workspace_id: string(record, 'workspace'), container_id: '', record }))
  for (const record of containers) {
    const project = projectMap[string(record, 'project')], server = serverMap[string(project, 'server')]
    targets.push({ resource_type: 'container', resource_id: record.id, resource_name: string(record, 'name'), workspace_id: string(server, 'workspace'), server_id: server.id, container_id: record.id, project_id: project.id, record })
  }
  return targets
}
function matches(rule, target) {
  if (string(rule, 'target_type') !== target.resource_type) return false
  const scope = string(rule, 'scope_type'), id = string(rule, 'scope_id')
  return scope === 'workspace' ? target.workspace_id === id : scope === 'server' ? target.server_id === id : target.container_id === id
}
function targetFields(target) {
  return { resource_type: target.resource_type, resource_id: target.resource_id, resource_name: String(target.resource_name || '').slice(0, 512), workspace_id: target.workspace_id || '', server_id: target.server_id || '', container_id: target.container_id || '' }
}
function states(app, rule) { return rows(app, 'alert_states', 'rule={:rule}', { rule: rule.id }) }
function stateFor(app, rule, target) {
  const existing = rows(app, 'alert_states', 'rule={:rule} && resource_type={:type} && resource_id={:id}', { rule: rule.id, type: target.resource_type, id: target.resource_id })[0]
  if (existing) return existing
  const fields = targetFields(target); delete fields.resource_name
  return create(app, 'alert_states', Object.assign(fields, { organization: string(rule, 'organization'), rule: rule.id, data: { revision: number(rule, 'revision') } }))
}
function audit(app, incident, kind, actor, data, now) {
  create(app, 'incident_events', { organization: string(incident, 'organization'), incident: incident.id, kind, actor: actor || '', occurred_at: iso(now), data: data || {} })
}
function invalidate(app, incident) {
  for (const notice of rows(app, 'incident_notifications', 'incident={:incident} && valid=true', { incident: incident.id })) {
    notice.set('valid', false); app.save(notice)
  }
}
function active(app, incident) {
  if (string(incident, 'status') !== 'open') return false
  const ruleId = string(incident, 'rule'), integrationId = string(incident, 'integration')
  if (ruleId) {
    const rule = app.findRecordById('alert_rules', ruleId)
    if (!boolean(rule, 'enabled') || boolean(rule, 'archived')) return false
  }
  if (integrationId && !boolean(app.findRecordById('alert_integrations', integrationId), 'enabled')) return false
  return true
}
function notice(app, incident, kind, now) {
  invalidate(app, incident)
  const resolved = kind === 'resolved' && string(incident, 'status') === 'resolved'
  if (!resolved && (!active(app, incident) || (!['claimed', 'claim_extended'].includes(kind) && time(string(incident, 'claim_until')) > now))) return
  const latest = app.findRecordsByFilter('incident_notifications', '', '-sequence', 1, 0)
  create(app, 'incident_notifications', { organization: string(incident, 'organization'), incident: incident.id, kind, sequence: latest.length ? number(latest[0], 'sequence') + 1 : 1, schedule_generation: number(incident, 'schedule_generation'), valid: true, occurred_at: iso(now) })
}
function openIncident(app, fields, actor, now) {
  const incident = create(app, 'incidents', Object.assign({ status: 'open', severity: 'warning', origin: 'api', title: 'Incident', evidence: {}, opened_at: iso(now), reminder_seconds: 900, assignee: '', claim_until: '', schedule_generation: 1, version: 1 }, fields))
  incident.set('next_reminder_at', iso(now + number(incident, 'reminder_seconds') * 1000)); app.save(incident)
  audit(app, incident, 'opened', actor, { evidence: json(incident, 'evidence') }, now)
  notice(app, incident, 'opening', now)
  return incident
}
function resolve(app, incident, reason, actor, now) {
  now = instant(now)
  if (!['manual', 'recovered', 'source_closed', 'rule_changed', 'rule_archived', 'resource_removed', 'resource_transferred'].includes(reason)) throw new Error('Invalid resolution reason')
  if (string(incident, 'status') === 'resolved') return incident
  invalidate(app, incident)
  assign(incident, { status: 'resolved', resolved_at: iso(now), resolution_reason: reason, next_reminder_at: '', schedule_generation: number(incident, 'schedule_generation') + 1, version: number(incident, 'version') + 1 })
  app.save(incident); audit(app, incident, 'resolved', actor, { reason }, now)
  if (['manual', 'recovered', 'source_closed'].includes(reason)) notice(app, incident, 'resolved', now)
  return incident
}
function ruleIncidents(app, rule) { return rows(app, 'incidents', 'rule={:rule} && status="open"', { rule: rule.id }) }
function resetStates(app, rule) {
  for (const state of states(app, rule)) { state.set('data', { revision: number(rule, 'revision') }); app.save(state) }
}
function saveRule(app, org, key, body, actor, now) {
  now = instant(now); key = text(key, 'key', 120, true)
  const values = normalizeRule(body)
  const rule = rows(app, 'alert_rules', 'organization={:org} && key={:key}', { org, key })[0]
  if (!rule) return create(app, 'alert_rules', Object.assign(values, { organization: org, key, archived: false, edit_version: 1, revision: 1, activated_at: iso(now) }))
  if (boolean(rule, 'archived')) conflict('Archived rule key cannot be reused')
  const changed = ['scope_type', 'scope_id', 'target_type'].some(field => string(rule, field) !== values[field]) || canonical(json(rule, 'condition')) !== canonical(values.condition) || number(rule, 'duration_seconds') !== values.duration_seconds
  const enabled = boolean(rule, 'enabled'), cadenceChanged = number(rule, 'reminder_seconds') !== values.reminder_seconds
  assign(rule, values)
  rule.set('edit_version', number(rule, 'edit_version') + 1)
  if (changed) rule.set('revision', number(rule, 'revision') + 1)
  if (changed || (!enabled && values.enabled)) rule.set('activated_at', iso(now))
  app.save(rule)
  if (changed || enabled !== values.enabled) resetStates(app, rule)
  for (const incident of ruleIncidents(app, rule)) {
    if (changed) { resolve(app, incident, 'rule_changed', actor, now); continue }
    if (enabled !== values.enabled || cadenceChanged) {
      invalidate(app, incident)
      incident.set('schedule_generation', number(incident, 'schedule_generation') + 1)
      incident.set('version', number(incident, 'version') + 1)
      incident.set('reminder_seconds', values.reminder_seconds)
      incident.set('next_reminder_at', enabled !== values.enabled ? '' : iso(Math.max(now + values.reminder_seconds * 1000, time(string(incident, 'claim_until')) || 0)))
      app.save(incident)
      audit(app, incident, enabled !== values.enabled ? (values.enabled ? 'rule_enabled' : 'rule_disabled') : 'cadence_changed', actor, {}, now)
    }
  }
  return rule
}
function archiveRule(app, rule, actor, now) {
  rule.set('edit_version', number(rule, 'edit_version') + 1)
  now = instant(now)
  if (boolean(rule, 'archived')) return rule
  assign(rule, { archived: true, enabled: false }); app.save(rule); resetStates(app, rule)
  for (const incident of ruleIncidents(app, rule)) resolve(app, incident, 'rule_archived', actor, now)
  return rule
}
function finite(value) { return typeof value === 'number' && Number.isFinite(value) }
function bytes(value) { return finite(value) && value >= 0 }
function compare(value, operator, expected) {
  if (operator === 'gt') return value > expected
  if (operator === 'gte') return value >= expected
  if (operator === 'lt') return value < expected
  if (operator === 'lte') return value <= expected
  if (operator === 'eq') return value === expected
  return value !== expected
}
function timedBands(condition) { return condition.critical_value !== undefined && ['host.cpu_percent', 'host.memory_percent'].includes(condition.metric) }
function severityFor(condition, severity, evidence) {
  if (condition.critical_value === undefined) return severity
  if (timedBands(condition)) return finite(evidence.value) && compare(evidence.value, condition.operator, condition.critical_value) ? 'critical' : 'warning'
  return (evidence.affected_disks || []).some(disk => finite(disk.value) && compare(disk.value, condition.operator, condition.critical_value)) ? 'critical' : 'warning'
}
function measured(condition, raw, container, priorEvidence) {
  const metric = condition.metric, evidence = { metric, observed_at: raw.observed_at, sample_id: raw.sample_id || '' }
  let value
  if (metric.indexOf('host.') === 0) {
    const host = raw.host || {}
    if (raw.metrics_complete === false && (raw.host === undefined || raw.host && typeof raw.host === 'object' && !Array.isArray(raw.host))) {
      const has = key => Object.prototype.hasOwnProperty.call(host, key)
      const absent = metric === 'host.cpu_percent' ? !has('cpu_percent') : metric === 'host.memory_percent' ? !has('memory_total_bytes') && !has('memory_available_bytes') : !has('disks')
      if (absent) return { result: 'skipped', value: null, evidence }
    }
    if (metric === 'host.cpu_percent') value = finite(host.cpu_percent) && host.cpu_percent >= 0 ? host.cpu_percent : null
    if (metric === 'host.memory_percent') value = bytes(host.memory_total_bytes) && host.memory_total_bytes > 0 && bytes(host.memory_available_bytes) && host.memory_available_bytes <= host.memory_total_bytes ? (host.memory_total_bytes - host.memory_available_bytes) / host.memory_total_bytes * 100 : null
    if (metric === 'host.disk_percent') {
      const path = condition.disk_path || '*', disks = Array.isArray(host.disks) ? host.disks : []
      const selected = disks.filter(disk => disk && typeof disk.path === 'string' && (path === '*' || disk.path === path))
      const valid = selected.filter(disk => bytes(disk.total_bytes) && disk.total_bytes > 0 && bytes(disk.available_bytes) && disk.available_bytes <= disk.total_bytes)
      const values = valid.map(disk => ({ path: disk.path, total_bytes: disk.total_bytes, available_bytes: disk.available_bytes, value: (disk.total_bytes - disk.available_bytes) / disk.total_bytes * 100 }))
      const affected = values.filter(disk => compare(disk.value, condition.operator, condition.value))
      evidence.disks = values; evidence.affected_disks = affected
      value = values.length ? Math.max.apply(null, values.map(disk => disk.value)) : null
      const prior = priorEvidence && Array.isArray(priorEvidence.affected_disks) ? priorEvidence.affected_disks : []
      const missingAffected = prior.some(disk => !valid.some(current => current.path === disk.path))
      evidence.value = value
      return { result: affected.length ? 'true' : !values.length || valid.length !== selected.length || missingAffected ? 'unknown' : 'false', value, evidence, complete: valid.length === selected.length }
    }
  } else {
    if (!container) return { result: 'skipped', value: null, evidence }
    if (metric === 'container.cpu_percent' || metric === 'container.memory_percent') {
      if (raw.metrics_complete === false) return { result: 'skipped', value: null, evidence }
      value = metric === 'container.cpu_percent' ? (finite(container.cpu_percent) && container.cpu_percent >= 0 ? container.cpu_percent : null) : (bytes(container.memory_bytes) && bytes(container.memory_limit_bytes) && container.memory_limit_bytes > 0 ? container.memory_bytes / container.memory_limit_bytes * 100 : null)
    } else {
      value = metric === 'container.state' ? container.state : container.health
      const descriptor = catalog().find(item => item.id === metric)
      if (!descriptor || !descriptor.values.includes(value)) value = null
    }
    evidence.docker_id = container.docker_id || ''
  }
  evidence.value = value
  return { result: value === null || value === undefined ? 'unknown' : String(compare(value, condition.operator, condition.value)), value: value === undefined ? null : value, evidence }
}
function eligible(raw, rule, now) {
  const observed = time(raw.observed_at), effective = Math.min(observed, now)
  return Number.isFinite(observed) && observed <= now + 300000 && effective >= now - 900000 && effective > time(string(rule, 'activated_at')) ? effective : null
}
function openFor(app, rule, target) {
  return rows(app, 'incidents', 'rule={:rule} && resource_type={:type} && resource_id={:id} && status="open"', { rule: rule.id, type: target.resource_type, id: target.resource_id })[0]
}
function evaluate(app, rule, target, observation, effective, rawObserved, sampleId, now) {
  const state = stateFor(app, rule, target), data = json(state, 'data'), revision = number(rule, 'revision')
  const condition = json(rule, 'condition'), timed = timedBands(condition)
  if (data.revision !== revision) { assign(data, { revision, pending_since: null, last_usable: null, last_raw: null, satisfied: false }); if (timed) data.critical_pending_since = null }
  if (data.last_raw !== undefined && data.last_raw !== null && rawObserved <= data.last_raw) return
  if (observation.result === 'skipped') return
  const incident = openFor(app, rule, target)
  const gap = data.last_usable === undefined || data.last_usable === null || effective - data.last_usable > 600000
  if (gap) { data.pending_since = null; data.satisfied = false; if (timed) data.critical_pending_since = null }
  data.last_raw = rawObserved; data.last_sample_id = sampleId || ''; data.last_result = observation.result; data.last_evidence = observation.evidence
  if (observation.result === 'unknown') {
    data.pending_since = null; data.satisfied = false
    if (timed) data.critical_pending_since = null
  } else {
    data.last_usable = effective
    if (observation.result === 'false') {
      data.pending_since = null; data.satisfied = false
      if (timed) data.critical_pending_since = null
      if (incident) resolve(app, incident, 'recovered', '', now)
    } else {
      if (data.pending_since === null || data.pending_since === undefined) data.pending_since = effective
      data.satisfied = !!data.satisfied || effective - data.pending_since >= number(rule, 'duration_seconds') * 1000
      let criticalSatisfied = true
      if (timed) {
        if (severityFor(condition, 'warning', observation.evidence) === 'critical') {
          if (data.critical_pending_since === null || data.critical_pending_since === undefined) data.critical_pending_since = effective
          criticalSatisfied = effective - data.critical_pending_since >= number(rule, 'duration_seconds') * 1000
        } else { data.critical_pending_since = null; criticalSatisfied = false }
      }
      if (incident) {
        const evidence = observation.evidence
        const previous = json(incident, 'evidence')
        if (Array.isArray(previous.affected_disks) && Array.isArray(evidence.affected_disks)) {
          for (const disk of previous.affected_disks) if (!evidence.disks.some(current => current.path === disk.path)) evidence.affected_disks.push(disk)
        }
        incident.set('evidence', evidence)
        const previousSeverity = string(incident, 'severity')
        let severity = severityFor(condition, previousSeverity, evidence)
        if (timed && severity === 'critical' && previousSeverity !== 'critical' && !criticalSatisfied) severity = 'warning'
        if (previousSeverity === 'critical' && severity === 'warning' && observation.complete === false) severity = previousSeverity
        if (severity !== previousSeverity) {
          const deadline = time(string(incident, 'claim_until')), due = time(string(incident, 'next_reminder_at'))
          invalidate(app, incident)
          assign(incident, { severity, version: number(incident, 'version') + 1, schedule_generation: number(incident, 'schedule_generation') + 1, next_reminder_at: iso(deadline > now ? deadline : now + number(incident, 'reminder_seconds') * 1000) })
          app.save(incident)
          audit(app, incident, 'severity_changed', '', { from: previousSeverity, to: severity }, now)
          if (Number.isFinite(deadline) && deadline <= now && due <= deadline) audit(app, incident, 'claim_expired', '', { claim_until: string(incident, 'claim_until') }, now)
          notice(app, incident, 'reminder', now)
        } else if (!string(incident, 'next_reminder_at')) {
          incident.set('next_reminder_at', iso(Math.max(now + number(incident, 'reminder_seconds') * 1000, time(string(incident, 'claim_until')) || 0)))
          notice(app, incident, 'reminder', now)
        }
        app.save(incident)
      } else if (data.satisfied) {
        let severity = severityFor(condition, string(rule, 'severity'), observation.evidence)
        if (timed && severity === 'critical' && !criticalSatisfied) severity = 'warning'
        openIncident(app, Object.assign(targetFields(target), { organization: string(rule, 'organization'), rule: rule.id, origin: 'rule', title: string(rule, 'name'), severity, rule_revision: revision, evidence: observation.evidence, reminder_seconds: number(rule, 'reminder_seconds') }), '', now)
      }
    }
  }
  state.set('data', data); app.save(state)
}
function closeScopeExits(app, rule, targets, now) {
  for (const incident of ruleIncidents(app, rule)) {
    if (!targets.some(target => target.resource_type === string(incident, 'resource_type') && target.resource_id === string(incident, 'resource_id'))) resolve(app, incident, 'rule_changed', '', now)
  }
}
function evaluateSnapshot(app, serverId, raw, reconciliation, now) {
  now = instant(now)
  if (!reconciliation || !reconciliation.applied) return
  const server = app.findRecordById('servers', serverId), workspace = app.findRecordById('workspaces', string(server, 'workspace')), org = string(workspace, 'organization')
  const targets = inventory(app, org).filter(target => target.server_id === serverId)
  const rules = rows(app, 'alert_rules', 'organization={:org} && enabled=true && archived=false', { org })
  for (const rule of rules) {
    const effective = eligible(raw, rule, now)
    if (effective === null) continue
    const condition = json(rule, 'condition')
    for (const target of targets.filter(target => matches(rule, target))) {
      if (condition.metric === 'server.no_communication_seconds') {
        const agent = rows(app, 'server_agents', 'server={:server}', { server: serverId })[0]
        if (!agent) continue
        const state = stateFor(app, rule, target), data = json(state, 'data')
        const contact = Math.max(effective, data.last_contact || 0)
        data.last_contact = contact; state.set('data', data); app.save(state)
        const elapsed = Math.max(0, (now - contact) / 1000)
        evaluate(app, rule, target, { result: String(compare(elapsed, condition.operator, condition.value)), value: elapsed, evidence: { metric: condition.metric, value: elapsed, last_contact_at: iso(contact), observed_at: iso(effective), sample_id: raw.sample_id || '' } }, now, now, raw.sample_id, now)
        continue
      }
      let container = null
      if (target.resource_type === 'container') {
        container = (raw.containers || []).find(item => reconciliation.containers && reconciliation.containers[item.name] === target.resource_id)
        if (!container && raw.docker_complete && (reconciliation.missing || []).includes(target.resource_id)) container = { state: 'missing' }
      }
      const incident = openFor(app, rule, target)
      evaluate(app, rule, target, measured(condition, raw, container, incident ? json(incident, 'evidence') : null), effective, time(raw.observed_at), raw.sample_id, now)
    }
  }
}
function claim(app, incident, userId, claimUntil, expectedVersion, now) {
  now = instant(now)
  const deadline = time(claimUntil)
  if (!Number.isFinite(deadline) || deadline <= now || deadline > now + 604800000) throw new Error('Invalid claim deadline')
  if (string(incident, 'status') !== 'open' || expectedVersion !== number(incident, 'version')) conflict('Incident changed; refresh before claiming')
  const currentDeadline = time(string(incident, 'claim_until')), owner = string(incident, 'assignee'), extending = currentDeadline > now
  if (extending && owner !== userId) conflict('Incident is already claimed')
  if (extending && deadline <= currentDeadline) throw new Error('Extension must increase the deadline')
  invalidate(app, incident)
  assign(incident, { assignee: userId, claim_until: iso(deadline), next_reminder_at: iso(deadline), version: number(incident, 'version') + 1, schedule_generation: number(incident, 'schedule_generation') + 1 })
  app.save(incident); audit(app, incident, extending ? 'claim_extended' : 'claimed', userId, { claim_until: iso(deadline), previous_assignee: owner }, now)
  notice(app, incident, extending ? 'claim_extended' : 'claimed', now)
  return incident
}
function tick(app, now) {
  now = instant(now)
  const rules = rows(app, 'alert_rules', 'archived=false')
  const inventoryByOrg = {}
  for (const rule of rules) {
    const org = string(rule, 'organization')
    if (!inventoryByOrg[org]) inventoryByOrg[org] = inventory(app, org)
    const targets = inventoryByOrg[org].filter(target => matches(rule, target))
    closeScopeExits(app, rule, targets, now)
    if (!boolean(rule, 'enabled')) continue
    const condition = json(rule, 'condition')
    if (condition.metric !== 'server.no_communication_seconds') continue
    for (const target of targets) {
      const agent = rows(app, 'server_agents', 'server={:server}', { server: target.server_id })[0]
      if (!agent) {
        const incident = openFor(app, rule, target)
        if (incident) resolve(app, incident, 'resource_removed', '', now)
        continue
      }
      const state = stateFor(app, rule, target), data = json(state, 'data')
      const grace = Math.max(time(string(rule, 'activated_at')) || now, time(string(agent, 'created')) || now)
      const contact = Math.max(grace, data.last_contact || 0), elapsed = Math.max(0, (now - contact) / 1000)
      const positive = compare(elapsed, condition.operator, condition.value)
      const observation = { result: String(positive), value: elapsed, evidence: { metric: condition.metric, value: elapsed, last_contact_at: iso(contact), observed_at: iso(now) } }
      evaluate(app, rule, target, observation, now, now, '', now)
    }
  }
  for (const incident of rows(app, 'incidents', 'status="open"')) {
    if (!active(app, incident)) continue
    const due = time(string(incident, 'next_reminder_at')), deadline = time(string(incident, 'claim_until'))
    if (!Number.isFinite(due) || due > now || deadline > now) continue
    if (Number.isFinite(deadline) && due <= deadline) audit(app, incident, 'claim_expired', '', { claim_until: string(incident, 'claim_until') }, now)
    notice(app, incident, 'reminder', now)
    incident.set('next_reminder_at', iso(now + number(incident, 'reminder_seconds') * 1000))
    incident.set('version', number(incident, 'version') + 1); app.save(incident)
  }
}
function createIncident(app, org, body, actor, now) {
  now = instant(now)
  if (!body || typeof body !== 'object') throw new Error('Invalid incident')
  const severity = body.severity === undefined ? 'warning' : body.severity
  if (!['info', 'warning', 'critical'].includes(severity)) throw new Error('Invalid severity')
  const fields = { organization: org, origin: 'api', title: text(body.title, 'title', 240, true), severity, evidence: body.evidence || {}, reminder_seconds: bounded(body.reminder_seconds, 900, 60, 604800, 'reminder interval') }
  for (const key of ['resource_type', 'resource_id', 'resource_name', 'workspace_id', 'server_id', 'container_id']) fields[key] = body[key] === undefined ? '' : text(body[key], key, key === 'resource_name' ? 512 : key === 'resource_type' ? 64 : key === 'resource_id' ? 240 : 15, false)
  return openIncident(app, fields, actor, now)
}
function sourceEvent(app, integration, event, now) {
  now = instant(now)
  if (!boolean(integration, 'enabled')) throw new Error('Integration is disabled')
  const externalId = text(event.external_id, 'external identity', 240, true)
  if (!['open', 'closed'].includes(event.state)) throw new Error('Invalid source state')
  const org = string(integration, 'organization'), sourceKey = JSON.stringify([org, integration.id, externalId])
  const existing = rows(app, 'incidents', 'source_key={:key}', { key: sourceKey })[0]
  if (existing) {
    if (string(existing, 'status') === 'resolved') return existing
    if (event.state === 'closed') return resolve(app, existing, 'source_closed', integration.id, now)
    const fields = { evidence: event.evidence || {} }
    if (event.title !== undefined) fields.title = text(event.title, 'title', 240, true)
    if (event.severity !== undefined) {
      if (!['info', 'warning', 'critical'].includes(event.severity)) throw new Error('Invalid severity')
      fields.severity = event.severity
    }
    const changed = canonical(json(existing, 'evidence')) !== canonical(fields.evidence) || fields.title !== undefined && fields.title !== string(existing, 'title') || fields.severity !== undefined && fields.severity !== string(existing, 'severity')
    if (!changed) return existing
    assign(existing, fields); app.save(existing); audit(app, existing, 'source_updated', integration.id, { evidence: fields.evidence }, now)
    return existing
  }
  const fields = { organization: org, integration: integration.id, source_key: sourceKey, external_id: externalId, origin: string(integration, 'kind') === 'gcp' ? 'gcp' : 'api', title: event.title === undefined ? externalId : text(event.title, 'title', 240, true), severity: event.severity || 'warning', evidence: event.evidence || {}, resource_type: event.resource_type || 'external', resource_id: event.resource_id || externalId, resource_name: event.resource_name || externalId, workspace_id: string(integration, 'workspace_id'), reminder_seconds: number(integration, 'reminder_seconds') || 900 }
  if (!['info', 'warning', 'critical'].includes(fields.severity)) throw new Error('Invalid severity')
  if (event.state === 'closed') {
    const incident = create(app, 'incidents', Object.assign(fields, { status: 'resolved', opened_at: '', resolved_at: iso(now), resolution_reason: 'source_closed', schedule_generation: 1, version: 1 }))
    audit(app, incident, 'source_closed', integration.id, { closed_before_open: true }, now)
    return incident
  }
  return openIncident(app, fields, integration.id, now)
}
function validNotifications(app, org, cursor, limit, now) {
  now = instant(now)
  const after = Number(cursor || 0), count = limit === undefined ? 100 : Math.max(1, Math.min(100, Number(limit) || 100))
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid notification cursor')
  const notifications = rows(app, 'incident_notifications', 'organization={:org} && sequence>{:after}', { org, after }, 'sequence')
  const items = []; let next = after
  for (const entry of notifications) {
    next = number(entry, 'sequence')
    if (boolean(entry, 'valid')) {
      const incident = app.findRecordById('incidents', string(entry, 'incident'))
      if (string(incident, 'organization') === org && (string(entry, 'kind') === 'resolved' ? string(incident, 'status') === 'resolved' : active(app, incident)) && number(entry, 'schedule_generation') === number(incident, 'schedule_generation') && (string(entry, 'kind') === 'resolved' || (['claimed', 'claim_extended'].includes(string(entry, 'kind')) ? time(string(incident, 'claim_until')) > now : !(time(string(incident, 'claim_until')) > now)))) items.push({ sequence: next, incident_id: incident.id, kind: string(entry, 'kind'), title: string(incident, 'title'), severity: string(incident, 'severity'), occurred_at: string(entry, 'occurred_at') })
    }
    if (items.length >= count) break
  }
  return { items, cursor: String(next), open_count: rows(app, 'incidents', 'organization={:org} && status="open"', { org }).length }
}
function removeTarget(app, type, id, reason, actor, now) {
  now = instant(now)
  if (!['workspace', 'server', 'project', 'container'].includes(type) || !['resource_removed', 'resource_transferred'].includes(reason)) throw new Error('Invalid target removal')
  const projectContainers = type === 'project' ? rows(app, 'containers', 'project={:id}', { id }).map(record => record.id) : []
  const servers = type === 'workspace' ? rows(app, 'servers', 'workspace={:id}', { id }).map(record => record.id) : type === 'server' ? [id] : []
  const projects = servers.length ? rows(app, 'projects').filter(record => servers.includes(string(record, 'server'))).map(record => record.id) : []
  const containers = type === 'container' ? [id] : type === 'project' ? projectContainers : rows(app, 'containers').filter(record => projects.includes(string(record, 'project'))).map(record => record.id)
  for (const incident of rows(app, 'incidents', 'status="open"')) {
    const affected = type === 'project' ? projectContainers.includes(string(incident, 'container_id')) : string(incident, type + '_id') === id || (string(incident, 'resource_type') === type && string(incident, 'resource_id') === id)
    if (affected) resolve(app, incident, reason, actor, now)
  }
  for (const rule of rows(app, 'alert_rules', 'archived=false')) {
    const affected = string(rule, 'scope_type') === type && string(rule, 'scope_id') === id || string(rule, 'scope_type') === 'server' && servers.includes(string(rule, 'scope_id')) || string(rule, 'scope_type') === 'container' && containers.includes(string(rule, 'scope_id'))
    if (affected) { assign(rule, { archived: true, enabled: false }); app.save(rule) }
    for (const state of states(app, rule)) {
      const stateAffected = type === 'project' ? projectContainers.includes(string(state, 'container_id')) : string(state, type + '_id') === id || string(state, 'resource_type') === type && string(state, 'resource_id') === id
      if (stateAffected) { state.set('data', { revision: number(rule, 'revision'), ended_reason: reason, ended_at: iso(now) }); app.save(state) }
    }
  }
}
function simulate(app, org, body, now) {
  now = instant(now)
  const values = normalizeRule(body), condition = values.condition
  const rule = { getString(key) { const value = values[key]; return typeof value === 'object' ? JSON.stringify(value) : String(value || '') } }
  const targets = inventory(app, org).filter(target => matches(rule, target)), samples = {}
  const items = targets.map(target => {
    if (!(target.server_id in samples)) {
      const server = app.findRecordById('servers', target.server_id), current = json(server, 'telemetry')
      const latest = rows(app, 'telemetry_samples', 'server={:server}', { server: target.server_id }, '-observed_at').find(sample => time(string(sample, 'observed_at')) === time(current.observed_at))
      samples[target.server_id] = latest ? json(latest, 'payload') : null
    }
    const raw = samples[target.server_id]
    let observation = { result: 'unknown', value: null, evidence: { metric: condition.metric } }
    if (condition.metric === 'server.no_communication_seconds') {
      const agent = rows(app, 'server_agents', 'server={:server}', { server: target.server_id })[0]
      if (agent) {
        const contact = Math.max(time(string(agent, 'created')) || now, raw && Number.isFinite(time(raw.observed_at)) && time(raw.observed_at) <= now + 300000 ? Math.min(now, time(raw.observed_at)) : 0)
        const value = Math.max(0, (now - contact) / 1000)
        observation = { result: String(compare(value, condition.operator, condition.value)), value, evidence: { metric: condition.metric, last_contact_at: iso(contact) } }
      }
    } else if (raw && Number.isFinite(time(raw.observed_at)) && time(raw.observed_at) >= now - 900000 && time(raw.observed_at) <= now + 300000) {
      let container = null
      if (target.resource_type === 'container' && targets.filter(item => item.server_id === target.server_id && item.resource_name === target.resource_name).length === 1) {
        container = (raw.containers || []).find(item => item.name === target.resource_name)
        const current = json(target.record, 'telemetry')
        if (!container && raw.docker_complete && current.state === 'missing' && time(current.observed_at) === time(raw.observed_at)) container = { state: 'missing' }
      }
      observation = measured(condition, raw, container, null)
    }
    return Object.assign({ resource_type: target.resource_type, resource_id: target.resource_id, resource_name: target.resource_name, severity: observation.result === 'true' ? severityFor(condition, values.severity, observation.evidence) : null }, observation)
  })
  return { items, totalItems: items.length }
}
module.exports = { catalog, normalizeRule, saveRule, archiveRule, simulate, evaluateSnapshot, tick, claim, resolve, sourceEvent, createIncident, validNotifications, removeTarget }
