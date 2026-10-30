onRecordValidate(e => {
  const record = e.record
  if (!record.getString('version_control_status')) record.set('version_control_status','unknown')
  const fields = ['source_repository_url','deployment_branch','deployment_template']
  for (const field of fields) record.set(field,record.getString(field).trim())
  const errors = {}
  if (record.getString('source_repository_url').includes('\\')) {
    errors.source_repository_url = new ValidationError('invalid_repository_url','Use an HTTP or HTTPS repository URL without credentials.')
  }
  const template = record.getString('deployment_template')
  if (template && (/^[\/\\]/.test(template) || /(^|[\/\\])\.\.([\/\\]|$)/.test(template) || /[\x00-\x1f\\]/.test(template))) {
    errors.deployment_template = new ValidationError('invalid_template','Use a relative path inside the source repository.')
  }
  if (record.getString('version_control_status') === 'unversioned' && fields.some(field => record.getString(field))) {
    errors.version_control_status = new ValidationError('invalid_version_control_status','A project with repository details cannot be marked as unversioned.')
  }
  if (Object.keys(errors).length) throw new BadRequestError('Invalid repository details.',errors)
  return e.next()
},'projects')
