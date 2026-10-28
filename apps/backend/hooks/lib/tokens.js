module.exports = {
  metadata(record) {
    return {id:record.id,organization:record.getString('organization'),label:record.getString('label'),prefix:record.getString('prefix'),scope:record.getString('scope'),expires_at:record.getString('expires_at'),created:record.getString('created')}
  },
}
