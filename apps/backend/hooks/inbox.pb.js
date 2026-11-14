routerAdd('GET','/api/i7y/alerts/v1/inbox',e=>require(__hooks+'/lib/inbox.js').handle(e,'incidents'),$apis.requireAuth('users'))
routerAdd('GET','/api/i7y/alerts/v1/inbox/notification-events',e=>require(__hooks+'/lib/inbox.js').handle(e,'notifications'),$apis.requireAuth('users'))
