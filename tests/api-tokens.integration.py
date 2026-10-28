import json,os,uuid,urllib.request,urllib.error
base=os.environ['I7Y_TEST_URL'].rstrip('/')
email=os.environ['I7Y_TEST_EMAIL']
password=os.environ['I7Y_TEST_PASSWORD']
organization=None
other_email='token-test-'+uuid.uuid4().hex+'@example.com'
def call(path,method='GET',data=None,token=None):
 headers={'Content-Type':'application/json'}
 if organization:headers['X-I7y-Organization']=organization
 if token:headers['Authorization']='Bearer '+token
 req=urllib.request.Request(base+path,method=method,data=json.dumps(data).encode() if data is not None else None,headers=headers)
 try:
  with urllib.request.urlopen(req) as r:return r.status,json.loads(r.read() or '{}')
 except urllib.error.HTTPError as e:return e.code,json.load(e)
code,auth=call('/api/collections/users/auth-with-password','POST',{'identity':email,'password':password})
assert code==200,auth
session=auth['token']
organization=os.environ.get('I7Y_TEST_ORGANIZATION') or call('/api/i7y/organizations',token=session)[1]['items'][0]['id']
path='/api/i7y/tokens'
assert call(path)[0]==401
for resource in ['workspaces','servers','projects','containers']:
 assert call('/api/collections/'+resource+'/records')[0]==401
 assert call('/api/collections/'+resource+'/records/aaaaaaaaaaaaaaa')[0]==401
keys=[]
for scope in ['read','write']:
 code,result=call(path,'POST',{'organization':organization,'label':'Agent '+scope,'scope':scope,'days':1},session)
 assert code==201,(code,result)
 keys.append(result)
 token=result['token']
 code,info=call('/api/i7y/token',token=token)
 assert code==200 and info['scope']==scope and 'token' not in info
 assert call('/api/i7y/token','POST',{},token)[0]==403
 assert call('/api/collections/containers/records',token=token)[0]==200
 assert call('/api/collections/users/records',token=token)[0]==403
 assert call('/api/collections/users/auth-refresh','POST',token=token)[0]==403
 assert call(path,token=token)[0]==403
 code,row=call('/api/collections/workspaces/records','POST',{'organization':organization,'login':'api-token-'+scope},token)
 if scope=='read':assert code==403,(code,row)
 else:
  assert code==200,(code,row)
  assert call('/api/collections/workspaces/records/'+row['id'],'PATCH',{'provider':'test'},token)[0]==200
  assert call('/api/collections/workspaces/records/'+row['id'],'DELETE',token=token)[0]==204
code,listing=call(path,token=session)
assert code==200,listing
assert all('token' not in row and 'token_hash' not in row for row in listing['items'])
assert call(path,'POST',{'organization':organization,'label':'invalid','scope':'admin','days':0},session)[0]==400
for key in keys:
 assert call(path+'/'+key['id'],'DELETE',token=session)[0]==204
 assert call('/api/collections/containers/records',token=key['token'])[0]==401
assert call('/api/collections/containers/records',token='i7y_invalid')[0]==401
code,admin=call('/api/collections/_superusers/auth-with-password','POST',{'identity':email,'password':password})
assert code==200
code,second=call('/api/collections/users/records','POST',{'email':other_email,'password':'DisposableOther2026','passwordConfirm':'DisposableOther2026'},admin['token'])
assert code==200,second
_,other=call('/api/collections/users/auth-with-password','POST',{'identity':other_email,'password':'DisposableOther2026'})
_,key=call(path,'POST',{'organization':organization,'label':'Expiry test','scope':'read','days':1},session)
assert call(path+'/'+key['id'],'DELETE',token=other['token'])[0]==404
assert call(path,token=other['token'])[1]['items']==[]
assert call('/api/collections/api_tokens/records/'+key['id'],'PATCH',{'expires_at':'2000-01-01 00:00:00.000Z'},admin['token'])[0]==200
assert call('/api/collections/containers/records',token=key['token'])[0]==401
assert call(path+'/'+key['id'],'DELETE',token=session)[0]==204
assert call('/api/collections/users/records/'+second['id'],'DELETE',token=admin['token'])[0]==204
print('PASS: expiry, owner isolation;  creation, read/write scopes, inventory-only access, no refresh/escalation, hidden secrets, validation and revocation')
