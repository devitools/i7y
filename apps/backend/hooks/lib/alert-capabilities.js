const allowed = ['alerts:read','alerts:write','incidents:read','incidents:create','incidents:resolve']
function normalize(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(item => !allowed.includes(item))) throw new Error('Invalid alert capabilities')
  return [...new Set(value)]
}
function capabilities(record) {
  try { return normalize(JSON.parse(record.getString('capabilities') || '[]')) } catch (_) { return [] }
}
function forRoute(method,path) {
  const base='/api/i7y/alerts/v1'
  if (!path.startsWith(base+'/')) return ''
  const route=path.slice(base.length)
  if (method==='GET' && (/^\/rules(?:\/[^/]+)?$/.test(route) || route==='/metrics')) return 'alerts:read'
  if (method==='POST' && route==='/rules/simulate') return 'alerts:read'
  if (['PUT','DELETE'].includes(method) && /^\/rules\/[^/]+$/.test(route)) return 'alerts:write'
  if (method==='GET' && (/^\/incidents(?:\/[a-z0-9]{15})?$/.test(route) || route==='/notification-events')) return 'incidents:read'
  if (method==='POST' && route==='/incidents') return 'incidents:create'
  if (method==='POST' && /^\/incidents\/[a-z0-9]{15}\/resolve$/.test(route)) return 'incidents:resolve'
  return ''
}
module.exports={allowed,normalize,capabilities,forRoute}
