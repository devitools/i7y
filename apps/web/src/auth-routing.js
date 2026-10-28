export function protectedRoute(hash, authenticated) {
  const target = typeof hash === 'string' && hash.startsWith('#/') ? hash : '#/workspaces'
  if (/^#\/invite\/i7yi_[A-Za-z0-9]{64}$/.test(target)) return {hash:target}
  if (!authenticated) return target === '#/login' ? {hash:target} : {hash:'#/login',returnTo:target}
  return {hash:target === '#/login' ? '#/workspaces' : target}
}
