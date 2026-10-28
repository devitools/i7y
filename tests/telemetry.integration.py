import copy,json,os,uuid,urllib.request,urllib.error,urllib.parse,datetime
base=os.environ.get('I7Y_TEST_URL','http://127.0.0.1:8098')
access=json.load(open(os.environ.get('I7Y_TEST_ACCESS','/tmp/i7y-telemetry-test/access.json')))
def call(path,method='GET',data=None,token=None):
 h={'Content-Type':'application/json'}
 if token:h['Authorization']='Bearer '+token
 try:
  with urllib.request.urlopen(urllib.request.Request(base+path,method=method,data=None if data is None else json.dumps(data).encode(),headers=h)) as r:return r.status,json.loads(r.read() or '{}')
 except urllib.error.HTTPError as e:return e.code,json.load(e)
def ok(path,method='GET',data=None,token=None,status=200):
 code,r=call(path,method,data,token);assert code==status,(path,code,r);return r
admin=ok('/api/collections/_superusers/auth-with-password','POST',{'identity':access['email'],'password':access['password']})['token']
prefix='/api/collections/'
user=ok(prefix+'users/records','POST',{'email':'user-'+uuid.uuid4().hex+'@example.com','password':access['password'],'passwordConfirm':access['password']},admin)
session=ok(prefix+'users/auth-with-password','POST',{'identity':user['email'],'password':access['password']})['token']
organization=ok(prefix+'organizations/records','POST',{'name':'Telemetry fixture '+uuid.uuid4().hex},admin)
ok(prefix+'organization_memberships/records','POST',{'organization':organization['id'],'user':user['id'],'role':'admin'},admin)
w=ok(prefix+'workspaces/records','POST',{'login':'fixture-'+uuid.uuid4().hex,'organization':organization['id']},session)
s=ok(prefix+'servers/records','POST',{'workspace':w['id'],'name':'fixture','type':'VPS'},session)
s2=ok(prefix+'servers/records','POST',{'workspace':w['id'],'name':'other','type':'VPS'},session)
key=ok('/api/i7y/agents','POST',{'server':s['id']},session,status=201)['token']
assert call('/api/i7y/agents')[0]==401
assert call(prefix+'servers/records',token=key)[0]==401
assert call('/api/i7y/agents',token=key)[0]==401
assert call('/api/i7y/telemetry/v1/config',token=key)[0]==200
now=datetime.datetime.now(datetime.timezone.utc)
b={'version':1,'sample_id':uuid.uuid4().hex,'observed_at':now.isoformat(),'agent_version':'test','host':{'cpu_percent':1},'docker_complete':True,'discovery_complete':True,'projects':[{'key':'/projects/example','name':'example','path':'/projects/example'}],'containers':[{'name':'example-web','project_key':'/projects/example','image':'nginx:stable','state':'running','health':'none'}],'errors':[],'server':s2['id']}
path='/api/i7y/telemetry/v1/snapshots'
assert call(path,'POST',b)[0]==401
assert call(path,'POST',{**b,'containers':[{},{}]},key)[0]==400
assert not ok(path,'POST',b,key)['duplicate']
assert ok(path,'POST',b,key)['duplicate']
server=ok(prefix+'servers/records/'+s['id'],token=session)
assert server['telemetry']['state']=='healthy'
assert not ok(prefix+'servers/records/'+s2['id'],token=session).get('last_seen')
projects=ok(prefix+'projects/records',token=session)['items'];p=next(p for p in projects if p['server']==s['id'])
c=next(c for c in ok(prefix+'containers/records',token=session)['items'] if c['project']==p['id'])
assert c['telemetry']['state']=='running'
b2=copy.deepcopy(b);b2.update(sample_id=uuid.uuid4().hex,observed_at=(now+datetime.timedelta(seconds=1)).isoformat(),containers=[],docker_complete=False)
ok(path,'POST',b2,key)
assert ok(prefix+'containers/records/'+c['id'],token=session)['telemetry']['state']=='running'
b3={**b2,'sample_id':uuid.uuid4().hex,'observed_at':(now+datetime.timedelta(seconds=2)).isoformat(),'docker_complete':True}
ok(path,'POST',b3,key)
assert ok(prefix+'containers/records/'+c['id'],token=session)['telemetry']['state']=='missing'
old={**b,'sample_id':uuid.uuid4().hex,'observed_at':(now-datetime.timedelta(minutes=5)).isoformat()}
ok(path,'POST',old,key)
assert ok(prefix+'containers/records/'+c['id'],token=session)['telemetry']['state']=='missing'
moved=copy.deepcopy(b);moved.update(sample_id=uuid.uuid4().hex,observed_at=(now+datetime.timedelta(seconds=3)).isoformat());moved['projects']=[{'key':'new-key','name':'moved','path':'/projects/moved'}];moved['containers'][0]['project_key']='new-key'
ok(path,'POST',moved,key)
retained=ok(prefix+'containers/records/'+c['id'],token=session)
assert retained['project']==p['id'] and retained['telemetry']['state']=='running'
assert ok(prefix+'servers/records/'+s['id'],token=session)['telemetry']['warnings']
assert call(path,'POST',{**b,'sample_id':uuid.uuid4().hex,'observed_at':(now-datetime.timedelta(days=31)).isoformat()},key)[0]==400
image_update=copy.deepcopy(b);image_update.update(sample_id=uuid.uuid4().hex,observed_at=(now+datetime.timedelta(seconds=4)).isoformat());image_update['containers'][0]['image']='nginx:updated'
ok(path,'POST',image_update,key)
updated=ok(prefix+'containers/records/'+c['id'],token=session)
assert updated['image']=='nginx:updated' and updated['project']==p['id']
physical=copy.deepcopy(image_update);physical.update(sample_id=uuid.uuid4().hex,observed_at=(now+datetime.timedelta(seconds=5)).isoformat())
physical['containers'][0].update(docker_id='fixture-docker',cpu_percent=12.5,memory_bytes=1024)
physical['projects']=[{'key':p['id'],'name':'example','path':'/srv/physical/projects/example'}];physical['containers'][0]['project_key']=p['id']
before={v['id'] for v in ok(prefix+'projects/records',token=session)['items'] if v['server']==s['id']}
ok(path,'POST',physical,key)
assert ok(prefix+'projects/records/'+p['id'],token=session)['path']=='/srv/physical/projects/example'
assert ok(prefix+'containers/records/'+c['id'],token=session)['project']==p['id']
assert {v['id'] for v in ok(prefix+'projects/records',token=session)['items'] if v['server']==s['id']}==before
assert not ok(prefix+'servers/records/'+s['id'],token=session)['telemetry']['warnings']
fast=copy.deepcopy(physical);fast.update(sample_id=uuid.uuid4().hex,observed_at=(now+datetime.timedelta(seconds=6)).isoformat(),metrics_complete=False,reason='docker_event')
fast['containers'][0].update(cpu_percent=None,memory_bytes=None)
ok(path,'POST',fast,key)
assert ok(prefix+'containers/records/'+c['id'],token=session)['telemetry']['cpu_percent']==12.5
removed=copy.deepcopy(fast);removed.update(sample_id=uuid.uuid4().hex,observed_at=(now+datetime.timedelta(seconds=7)).isoformat(),containers=[])
ok(path,'POST',removed,key)
assert ok(prefix+'containers/records/'+c['id'],token=session)['telemetry']['state']=='missing'
visible=ok(prefix+'i7y_containers/records?filter='+urllib.parse.quote('server_id="'+s['id']+'" && state!="missing"'),token=session)
assert visible['totalItems']==0
all_rows=ok(prefix+'i7y_containers/records?filter='+urllib.parse.quote('server_id="'+s['id']+'"'),token=session)
assert all_rows['totalItems']==1 and all_rows['items'][0]['payload']['state']=='missing'
images=ok(prefix+'i7y_images/records?filter='+urllib.parse.quote('workspace_login="'+w['login']+'"'),token=session)
assert images['totalItems']==0
assert call(prefix+'telemetry_samples/records')[0]==401
samples=ok(prefix+'telemetry_samples/records',token=session)['items'];assert len([v for v in samples if v['server']==s['id']])==9
listing=ok('/api/i7y/agents',token=session)['items'];assert all('token_hash' not in k and 'token' not in k for k in listing)
new=ok('/api/i7y/agents','POST',{'server':s['id']},session,status=201)['token']
assert call(path,'POST',b,key)[0]==401
agent=next(a for a in ok('/api/i7y/agents',token=session)['items'] if a['server']==s['id'])
ok('/api/i7y/agents/'+agent['id'],'DELETE',token=session,status=204)
assert call(path,'POST',b,new)[0]==401
ok(prefix+'workspaces/records/'+w['id'],'DELETE',token=session,status=204)
assert all(v['server']!=s['id'] for v in ok(prefix+'telemetry_samples/records',token=session)['items'])
ok(prefix+'users/records/'+user['id'],'DELETE',token=admin,status=204)
ok(prefix+'organizations/records/'+organization['id'],'DELETE',token=admin,status=204)
print('PASS: authentication, host isolation, reconciliation, missing/partial collection, idempotency, late samples, history, rotation, revocation, cascade')
