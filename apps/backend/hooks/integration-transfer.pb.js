routerAdd('POST','/api/i7y/alerts/v1/integrations/{id}/transfer/preview',e=>require(__hooks+'/lib/integration-transfer.js').handle(e,false),$apis.requireAuth('users'),$apis.bodyLimit(4096))
routerAdd('POST','/api/i7y/alerts/v1/integrations/{id}/transfer',e=>require(__hooks+'/lib/integration-transfer.js').handle(e,true),$apis.requireAuth('users'),$apis.bodyLimit(4096))
