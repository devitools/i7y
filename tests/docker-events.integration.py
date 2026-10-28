import json,uuid,urllib.request,urllib.parse,threading,http.server,socketserver,tempfile,pathlib,subprocess,queue,time,os
base=os.environ.get('I7Y_TEST_URL','http://127.0.0.1:8098');access=json.load(open(os.environ.get('I7Y_TEST_ACCESS','/tmp/i7y-telemetry-test/access.json')));prefix='/api/collections/'
def call(path,data=None,token=None,method=None):
 h={'Content-Type':'application/json'}
 if token:h['Authorization']='Bearer '+token
 req=urllib.request.Request(base+path,data=json.dumps(data).encode() if data is not None else None,headers=h,method=method)
 with urllib.request.urlopen(req,timeout=15) as r:return json.loads(r.read() or '{}')
admin=call(prefix+'_superusers/auth-with-password',{'identity':access['email'],'password':access['password']})['token'];email='event-test-'+uuid.uuid4().hex+'@example.invalid';u=call(prefix+'users/records',{'email':email,'password':access['password'],'passwordConfirm':access['password']},admin);session=call(prefix+'users/auth-with-password',{'identity':email,'password':access['password']})['token'];org=call(prefix+'organizations/records',{'name':'Event fixture '+uuid.uuid4().hex},admin);call(prefix+'organization_memberships/records',{'organization':org['id'],'user':u['id'],'role':'admin'},admin);w=call(prefix+'workspaces/records',{'login':email,'organization':org['id']},session);s=call(prefix+'servers/records',{'workspace':w['id'],'name':'event-fixture','type':'VPS'},session);key=call('/api/i7y/agents',{'server':s['id']},session)['token']
mode=None;health='healthy';events=queue.Queue();disconnect=False
class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):daemon_threads=True
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  global disconnect
  path=urllib.parse.urlparse(self.path).path
  if path.endswith('/events'):
   self.send_response(200);self.end_headers();self.wfile.flush()
   while True:
    event=events.get()
    if event=='disconnect':return
    try:self.wfile.write((json.dumps({'Type':'container','Action':event,'time':int(time.time())})+'\n').encode());self.wfile.flush()
    except BrokenPipeError:return
  if path=='/version':data={'ApiVersion':'1.40'}
  elif path.endswith('/containers/json'):data=[{'Id':'fixture'}] if mode else []
  elif path.endswith('/containers/fixture/json'):
   data={'Id':'fixture','Name':'/event-fixture','Image':'sha256:fixture','Config':{'Image':'nginx:fixture','Labels':{'com.docker.compose.project':'fixture','com.docker.compose.project.working_dir':str(project)}},'State':{'Status':mode,'Health':{'Status':health}}}
  elif path.endswith('/stats'):data={'cpu_stats':{'cpu_usage':{'total_usage':200},'system_cpu_usage':2000,'online_cpus':2},'precpu_stats':{'cpu_usage':{'total_usage':100},'system_cpu_usage':1000},'memory_stats':{'usage':1000,'limit':2000}}
  else:self.send_error(404);return
  self.send_response(200);self.end_headers();self.wfile.write(json.dumps(data).encode())
def records():
 return call(prefix+'containers/records?'+urllib.parse.urlencode({'filter':'project.server="'+s['id']+'"'}),token=session)['items']
def await_state(expected,timeout=18):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  rows=records()
  if rows and rows[0].get('telemetry',{}).get('state')==expected:return rows[0]
  time.sleep(.3)
 raise AssertionError('state did not update: '+str(expected))
proc=None
try:
 with tempfile.TemporaryDirectory(prefix='i7y-e2e-',dir='/tmp') as tmp:
  root=pathlib.Path(tmp);project=root/'example';project.mkdir();(project/'compose.yaml').write_text('services: {}');sock=str(root/'docker.sock');server=Server(sock,Handler);threading.Thread(target=server.serve_forever,daemon=True).start();cfg=root/'config.json';cfg.write_text(json.dumps({'url':base,'token':key,'docker_socket':sock,'state_dir':str(root/'state'),'roots':[str(root)]}));cfg.chmod(0o600)
  with open(root/'agent.log','w') as output:
   proc=subprocess.Popen([os.environ.get('I7Y_TEST_AGENT','/tmp/i7y-agent-event-test'),'-config',str(cfg)],stdout=output,stderr=output)
   time.sleep(3)
   mode='running';events.put('start');row=await_state('running');id=row['id'];print('PASS start event -> running before periodic timer',flush=True)
   health='unhealthy';events.put('health_status: unhealthy');end=time.monotonic()+18
   while time.monotonic()<end:
    if records()[0]['telemetry'].get('health')=='unhealthy':break
    time.sleep(.3)
   else:raise AssertionError('health not updated')
   print('PASS health event -> unhealthy',flush=True)
   mode='exited';events.put('die');assert await_state('exited')['id']==id;print('PASS die event -> stopped with same ID',flush=True)
   events.put('disconnect');time.sleep(.5);mode=None
   row=await_state('missing',25);assert row['id']==id
   print('PASS reconnect reconciliation -> removal missed during disconnect',flush=True)
   visible=call(prefix+'i7y_containers/records?'+urllib.parse.urlencode({'filter':'server_id="'+s['id']+'" && state!="missing"'}),token=session);assert visible['totalItems']==0
   print('PASS removed container hidden by server-side filter',flush=True)
   proc.terminate();proc.wait(timeout=5);proc=None
finally:
 if proc:proc.terminate();proc.wait(timeout=5)
 call(prefix+'workspaces/records/'+w['id'],token=session,method='DELETE');call(prefix+'users/records/'+u['id'],token=admin,method='DELETE')
