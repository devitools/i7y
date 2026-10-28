onMailerSend(e=>{
  if($os.getenv('I7Y_LOCAL_REHEARSAL')==='1')throw new ForbiddenError('Email disabled in the local rehearsal')
  return e.next()
})
