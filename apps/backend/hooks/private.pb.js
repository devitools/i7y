routerUse(new Middleware((e) => {
  if (/^\/api\/collections\/((?:i7y_)?(?:workspaces|servers|projects|containers|images)|telemetry_samples|server_agents)\/records(?:\/|$)/.test(e.request.url.path) && (!e.auth || (!e.auth.isSuperuser() && e.auth.collection().name !== 'users'))) throw new UnauthorizedError('Sign in to access the inventory')
  return e.next()
}, -900))
