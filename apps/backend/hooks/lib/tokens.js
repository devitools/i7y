module.exports = {
  metadata(record) {
    let capabilities=[]
    try {capabilities=JSON.parse(record.getString('capabilities') || '[]')} catch (_) {}
    return {id:record.id,organization:record.getString('organization'),label:record.getString('label'),prefix:record.getString('prefix'),scope:record.getString('scope'),capabilities,expires_at:record.getString('expires_at'),created:record.getString('created')}
  },
}
