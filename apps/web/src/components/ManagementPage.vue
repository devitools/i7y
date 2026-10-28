<script setup>
import { computed, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { management, inventoryPage, inventoryScope } from '../api'
import { t } from '../i18n'
const props = defineProps({route:Object, canEdit:Boolean, authenticated:Boolean})
const emit = defineEmits(['back','saved','signed-in'])
const q = useQuasar()
const ready = ref(false)
const loading = ref(false), busy = ref(false), error = ref(''), fieldErrors = ref({}), form = ref({}), record = ref(null)
const workspaces = ref([]), servers = ref([]), projects = ref([]), descendants = ref({})
const resourceLabel = computed(() => ({workspaces:'Workspace',servers:'Server',projects:'Project',containers:'Container'})[props.route.resource])
const login = computed(() => props.route.view === 'login')
const deleting = computed(() => props.route.action === 'delete')
const title = computed(() => login.value ? t('Sign in') : `${t(deleting.value ? 'Delete' : props.route.action === 'new' ? 'Create' : 'Edit')} ${t(resourceLabel.value)}`)
const workspaceOptions = computed(() => workspaces.value.map(w => ({label:w.login,value:w.id})))
const serverOptions = computed(() => servers.value.filter(s=>s.type==='VPS' || s.id===form.value.server).map(s=>({label:`${s.name || s.ip || s.product || s.id} / ${s.account || ''}`,value:s.id})))
const projectOptions = computed(() => projects.value.map(p=>({label:`${p.name} / ${p.server?.name || ''}`,value:p.id})))
const required = value => !!String(value ?? '').trim() || t('Required field')
function failure(e) {
  fieldErrors.value = Object.fromEntries(Object.entries(e.response?.data || {}).map(([key,value])=>[key,value.message]))
  error.value = e.status === 401 || e.status === 403 ? t('Your session expired or you do not have permission. Sign in again.') : Object.keys(fieldErrors.value).length ? t('Review the highlighted fields.') : t('Unable to complete this action. Check your connection and permissions, then try again.')
}
async function load() {
  ready.value=false
  error.value=''; fieldErrors.value={}; record.value=null; form.value={}; descendants.value={}
  if (login.value) { form.value={email:'',password:''}; return }
  if (!props.canEdit) return
  loading.value=true
  try {
    record.value=props.route.id ? await management.get(props.route.resource,props.route.id) : null
    const r=record.value || {}
    const parent=props.route.parent
    const defaults={workspaces:{login:'',provider:''},servers:{workspace:parent || null,type:'VPS',name:'',product:'',ip:'',status:'ACTIVE',inventory_known:true,sort_order:0},projects:{server:parent || null,name:'',path:'',sort_order:0},containers:{project:parent || null,name:'',image:'',sort_order:0}}
    form.value={...defaults[props.route.resource],...r}
    if (deleting.value) {
      const summary=await inventoryScope(props.route.resource,r.id)
      if(!summary)throw new Error('Missing record')
      descendants.value={servers:props.route.resource==='workspaces'?summary.service_count:0,projects:['workspaces','servers'].includes(props.route.resource)?summary.project_count:0,containers:props.route.resource==='workspaces'?summary.containers:props.route.resource==='containers'?0:summary.container_count}
    } else {
      const relation={servers:['workspaces','workspace'],projects:['servers','server'],containers:['projects','project']}[props.route.resource]
      if(relation) {
        const [parentResource,field]=relation
        const result=await inventoryPage(parentResource,{perPage:50})
        const choices=[...result.items]
        if(form.value[field]&&!choices.some(row=>row.id===form.value[field])) {
          const selected=await inventoryScope(parentResource,form.value[field])
          if(selected)choices.push(selected)
        }
        if(parentResource==='workspaces')workspaces.value=choices
        if(parentResource==='servers')servers.value=choices
        if(parentResource==='projects')projects.value=choices
      }
    }
    ready.value=true
  } catch(e) { failure(e) } finally { loading.value=false }
}
async function lookup(resource,value,done) {
  try {
    const result=await inventoryPage(resource,{search:value,perPage:50})
    const current=resource==='workspaces'?workspaces:resource==='servers'?servers:projects
    const field=resource==='workspaces'?'workspace':resource==='servers'?'server':'project'
    const selected=current.value.find(row=>row.id===form.value[field])
    const items=[...result.items]
    if(selected&&!items.some(row=>row.id===selected.id))items.push(selected)
    done(()=>current.value=items)
  } catch {done(()=>{})}
}
watch(()=>[props.route.view,props.route.resource,props.route.action,props.route.id,props.route.parent,props.canEdit].join('|'),load,{immediate:true})
async function submit() {
  if (busy.value || (!login.value && !ready.value)) return
  busy.value=true; error.value=''; fieldErrors.value={}
  try {
    if (login.value) {
      await management.signIn(form.value.email.trim(),form.value.password)
      form.value.password=''
      emit('signed-in')
      return
    }
    if (!props.canEdit) return
    if (deleting.value) await management.remove(props.route.resource,props.route.id)
    else {
      const fields={workspaces:['login','provider'],servers:['workspace','type','name','product','ip','status','inventory_known','sort_order'],projects:['server','name','path','sort_order'],containers:['project','name','image','sort_order']}[props.route.resource]
      const values=Object.fromEntries(fields.map(key=>[key,typeof form.value[key]==='string' ? form.value[key].trim() : form.value[key]]))
      if (props.route.resource==='projects') await management.update('servers',values.server,{inventory_known:true})
      if (props.route.id) await management.update(props.route.resource,props.route.id,values)
      else await management.create(props.route.resource,values)
    }
    q.notify({type:'positive',message:t(deleting.value ? 'Record deleted' : 'Record saved')})
    emit('saved',props.route.resource)
  } catch(e) {
    if (login.value) error.value=t('Unable to sign in. Check your email and password.')
    else failure(e)
  } finally { busy.value=false }
}
</script>

<template>
  <q-page class="q-pa-md inventory-page" :class="{'login-page':login}">
    <div v-if="!login" class="page-heading"><h1>{{title}}</h1><q-btn v-if="!login" flat no-caps icon="arrow_back" :label="t('Back to list')" :disable="busy" @click="emit('back')" /></div>
    <q-card flat bordered class="management-card" :class="{'login-card':login}">
      <q-card-section v-if="loading" class="q-pa-xl text-center"><q-spinner color="primary" size="32px" /><p>{{t('Loading')}}</p></q-card-section>
      <q-card-section v-else-if="!login && !canEdit"><q-icon name="lock" size="28px" class="q-mb-md" /><p>{{t('Sign in to manage the inventory.')}}</p><q-btn v-if="!authenticated" color="primary" no-caps :label="t('Sign in')" href="#/login" /></q-card-section>
      <q-form v-else @submit="submit" class="q-pa-lg q-gutter-y-md">
        <q-banner v-if="error" class="bg-red-1 text-negative rounded-borders" role="alert">{{error}}<template #action><q-btn v-if="!login && !ready" flat :label="t('Try again')" @click="load" /></template></q-banner>
        <template v-if="login">
          <h1 class="login-title">{{title}}</h1>
          <p class="text-grey-7">{{t('Use your email and password to manage the inventory.')}}</p>
          <q-input v-model="form.email" outlined type="email" autocomplete="username" :label="t('Email')" :rules="[required]" autofocus />
          <q-input v-model="form.password" outlined type="password" autocomplete="current-password" :label="t('Password')" :rules="[required]" />
        </template>
        <template v-else-if="deleting && record">
          <div class="row items-center q-gutter-sm text-negative"><q-icon name="delete_outline" size="28px" /><h2 class="text-h6 q-my-none">{{record.login || record.name || record.product || record.id}}</h2></div>
          <p>{{t('This deletion is permanent.')}}</p>
          <q-list bordered separator class="rounded-borders"><q-item><q-item-section>{{t(resourceLabel)}}</q-item-section><q-item-section side>1</q-item-section></q-item><q-item v-for="(count,key) in Object.fromEntries(Object.entries(descendants).filter(([,count])=>count>0))" :key="key"><q-item-section>{{t({servers:'Servers',projects:'Projects',containers:'Containers'}[key])}}</q-item-section><q-item-section side>{{count}}</q-item-section></q-item></q-list>
        </template>
        <template v-else-if="!route.id || record">
          <template v-if="route.resource==='workspaces'">
            <q-input v-model="form.login" outlined :label="t('Workspace login')" :rules="[required]" :error="!!fieldErrors.login" :error-message="fieldErrors.login" autofocus />
            <q-input v-model="form.provider" outlined :label="t('Provider')" />
          </template>
          <template v-if="route.resource==='servers'">
            <q-select v-model="form.workspace" outlined :options="workspaceOptions" use-input input-debounce="300" @filter="(value,done)=>lookup('workspaces',value,done)" emit-value map-options :label="t('Workspace')" :rules="[required]" :error="!!fieldErrors.workspace" :error-message="fieldErrors.workspace" />
            <q-input v-model="form.name" outlined :label="t('Name')" :rules="[required]" :error="!!fieldErrors.name" :error-message="fieldErrors.name" />
            <q-input v-model="form.type" outlined :label="t('Type')" :rules="[required]" :hint="t('Use VPS for servers with projects and containers.')" />
            <q-input v-model="form.product" outlined :label="t('Product')" />
            <q-input v-model="form.ip" outlined :label="t('IP address')" />
            <q-input v-model="form.status" outlined :label="t('Provider status')" />
            <q-toggle v-model="form.inventory_known" :label="t('Internal inventory confirmed')" />
          </template>
          <template v-if="route.resource==='projects'">
            <q-select v-model="form.server" outlined :options="serverOptions" use-input input-debounce="300" @filter="(value,done)=>lookup('servers',value,done)" emit-value map-options :label="t('Server')" :rules="[required]" :error="!!fieldErrors.server" :error-message="fieldErrors.server" />
            <q-input v-model="form.name" outlined :label="t('Name')" :rules="[required]" :error="!!fieldErrors.name" :error-message="fieldErrors.name" />
            <q-input v-model="form.path" outlined :label="t('Directory path')" />
            <p class="text-caption text-grey-7">{{t('Saving a project confirms the internal inventory of its server.')}}</p>
          </template>
          <template v-if="route.resource==='containers'">
            <q-select v-model="form.project" outlined :options="projectOptions" use-input input-debounce="300" @filter="(value,done)=>lookup('projects',value,done)" emit-value map-options :label="t('Project')" :rules="[required]" :error="!!fieldErrors.project" :error-message="fieldErrors.project" />
            <q-input v-model="form.name" outlined :label="t('Name')" :rules="[required]" :error="!!fieldErrors.name" :error-message="fieldErrors.name" />
            <q-input v-model="form.image" outlined :label="t('Image')" :rules="[required]" :error="!!fieldErrors.image" :error-message="fieldErrors.image" />
          </template>
          <q-input v-if="route.resource!=='workspaces'" v-model.number="form.sort_order" outlined type="number" :label="t('Sort order')" />
        </template>
        <div class="row justify-end q-gutter-sm q-pt-md"><q-btn v-if="!login" flat no-caps :label="t('Cancel')" :disable="busy" @click="emit('back')" /><q-btn v-if="login || ready" type="submit" unelevated no-caps :color="deleting?'negative':'primary'" :icon="login?'login':deleting?'delete':'save'" :label="t(login?'Sign in':deleting?'Delete permanently':'Save')" :loading="busy" /></div>
      </q-form>
    </q-card>
  </q-page>
</template>

<style scoped>
.login-page {display:flex;justify-content:center;align-items:flex-start;padding-top:clamp(32px,8vh,88px)}
.login-card {width:100%;max-width:460px!important}
.login-title {font-size:26px;font-weight:600;line-height:1.3;margin:0}
.management-card {max-width:760px;margin:0 auto 24px}
.management-card h2 {overflow-wrap:anywhere}
.management-card :deep(.q-field__label) {max-width:100%}
</style>
