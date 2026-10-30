routerAdd('GET','/api/i7y/mobile/v1/info',e=>require(__hooks+'/lib/mobile.js').handle(e,'info'))
routerAdd('POST','/api/i7y/mobile/v1/auth/authorize',e=>require(__hooks+'/lib/mobile.js').handle(e,'authorize'),$apis.requireAuth('users'),$apis.bodyLimit(2048))
routerAdd('POST','/api/i7y/mobile/v1/auth/exchange',e=>require(__hooks+'/lib/mobile.js').handle(e,'exchange'),$apis.bodyLimit(2048))
routerAdd('GET','/api/i7y/mobile/v1/devices',e=>require(__hooks+'/lib/mobile.js').handle(e,'devices-list'),$apis.requireAuth('users'))
routerAdd('POST','/api/i7y/mobile/v1/devices',e=>require(__hooks+'/lib/mobile.js').handle(e,'device-save'),$apis.requireAuth('users'),$apis.bodyLimit(4096))
routerAdd('PATCH','/api/i7y/mobile/v1/devices/{id}',e=>require(__hooks+'/lib/mobile.js').handle(e,'device-locale'),$apis.requireAuth('users'),$apis.bodyLimit(4096))
routerAdd('DELETE','/api/i7y/mobile/v1/devices/{id}',e=>require(__hooks+'/lib/mobile.js').handle(e,'device-delete'),$apis.requireAuth('users'))
onRecordAfterCreateSuccess(e=>{
  e.next()
  try {require(__hooks+'/lib/mobile.js').enqueue(e.app,e.record)} catch (_) {}
},'incident_notifications')
cronAdd('i7y-mobile-outbox','* * * * *',()=>{
  const mobile=require(__hooks+'/lib/mobile.js')
  mobile.catchUp($app)
  mobile.dispatch($app)
  mobile.cleanup($app)
})
