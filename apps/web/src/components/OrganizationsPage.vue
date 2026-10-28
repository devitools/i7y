<script setup>
import { computed, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { activeOrganization, organizationChoices, globalAdmin, organizationApi, loadOrganizations, management } from '../api'
import { t, locale } from '../i18n'
const props=defineProps({route:Object})
const emit=defineEmits(['changed','select'])
const q=useQuasar()
const members=ref([]), invitations=ref([]), error=ref(''), busy=ref(false), loading=ref(false), link=ref(''), name=ref(''), email=ref(''), role=ref('reader'), workspaces=ref([]), workspace=ref(null), destination=ref(null), search=ref('')
const current=computed(()=>organizationChoices.value.find(r=>r.id===activeOrganization.value))
const admin=computed(()=>globalAdmin.value || current.value?.role==='admin')
const section=computed(()=>props.route?.section || 'organizations')
const action=computed(()=>props.route?.action || 'list')
const listing=computed(()=>action.value==='list')
const roles=computed(()=>[{label:t('Administrator'),value:'admin'},{label:t('Editor'),value:'editor'},{label:t('Read only'),value:'reader'}])
const roleLabel=value=>roles.value.find(r=>r.value===value)?.label || value
const selected=computed(()=>(section.value==='members'?members.value:invitations.value).find(r=>r.id===props.route?.id))
const protectedMember=row=>row?.role==='admin' && members.value.filter(member=>member.role==='admin').length===1
const memberProtected=computed(()=>section.value==='members' && protectedMember(selected.value))
const sectionLabel=computed(()=>t(section.value==='members'?'Members':section.value==='invitations'?'Invitations':'Organizations'))
const title=computed(()=>listing.value?sectionLabel.value:t(section.value==='members'?(action.value==='edit'?'Edit member':'Remove member'):section.value==='invitations'?(action.value==='new'?'Generate invitation':'Revoke invitation'):({new:'Create organization',edit:'Edit organization',delete:'Delete organization',transfer:'Transfer workspace'})[action.value]))
const back=computed(()=>section.value==='organizations'?'#/organizations':'#/organizations/'+section.value)
const rows=computed(()=>section.value==='organizations'?organizationChoices.value:section.value==='members'?members.value:invitations.value)
const status=row=>t(row.used_at?'Accepted':row.revoked_at?'Revoked':Date.parse(row.expires_at?.replace(' ','T'))<=Date.now()?'Expired':'Pending')
const columns=computed(()=>[
  {name:'name',label:t(section.value==='invitations'?'Email':'Name'),field:row=>row.name || row.email,align:'left',sortable:true},
  ...(section.value==='members'?[{name:'email',label:t('Email'),field:'email',align:'left',sortable:true}]:[]),
  {name:'role',label:t('Permission'),field:row=>roleLabel(row.role),align:'left',sortable:true},
  ...(section.value==='invitations'?[{name:'status',label:t('Status'),field:status,align:'left'},{name:'expires',label:t('Expires'),field:row=>new Date(row.expires_at.replace(' ','T')).toLocaleString(locale.value),align:'left'}]:[]),
  {name:'action',label:'',field:'id',align:'right'},
])
const allowed=computed(()=>section.value==='organizations'?(action.value==='edit'?admin.value:listing.value || globalAdmin.value):admin.value)
const required=value=>!!String(value || '').trim() || t('Required field')
function navigate(path){window.location.hash='#/organizations/'+path}
function open(row,path){emit('select',row.id,'#/organizations/'+path)}
async function load(){
  error.value='';link.value='';search.value='';name.value=action.value==='new'?'':current.value?.name || '';email.value='';role.value='reader';workspace.value=null;destination.value=null
  if(!allowed.value || section.value==='organizations')return
  loading.value=true
  try{
    if(section.value==='members')members.value=(await organizationApi.members(activeOrganization.value)).items
    else invitations.value=(await organizationApi.invitations(activeOrganization.value)).items
    if(!listing.value && action.value!=='new'){
      if(!selected.value)throw new Error(t('Record not found'))
      role.value=selected.value.role
    }
  }catch(e){error.value=e.response?.message || e.message || t('Unable to complete this action.')}finally{loading.value=false}
}
async function refresh(){loading.value=true;try{await loadOrganizations();emit('changed');await load()}catch(e){error.value=e.response?.message || t('Unable to complete this action.')}finally{loading.value=false}}
async function submit(){
  if(busy.value || !allowed.value)return
  if(memberProtected.value){error.value=t('Promote another administrator before removing or changing this member.');return}
  busy.value=true;error.value=''
  try{
    const org=activeOrganization.value
    if(section.value==='organizations'){
      if(action.value==='new')await organizationApi.create(name.value)
      if(action.value==='edit')await organizationApi.rename(org,name.value)
      if(action.value==='delete')await organizationApi.remove(org)
      if(action.value==='transfer')await organizationApi.transfer(workspace.value,destination.value)
    }else if(section.value==='members'){
      if(action.value==='edit')await organizationApi.updateMember(org,selected.value.id,role.value)
      else await organizationApi.removeMember(org,selected.value.id)
    }else if(action.value==='new'){
      const r=await organizationApi.invite(org,{email:email.value,role:role.value})
      link.value=window.location.origin+window.location.pathname+'#/invite/'+r.token
      return
    }else await organizationApi.revoke(org,selected.value.id)
    await loadOrganizations();emit('changed')
    q.notify({type:'positive',message:t('Record saved')})
    window.location.hash=back.value
  }catch(e){error.value=e.response?.message || t('Unable to complete this action.')}finally{busy.value=false}
}
async function searchWorkspace(value,done){try{const r=await management.list('workspaces',{filter:value?`login ~ ${JSON.stringify(value)}`:'',perPage:50});done(()=>workspaces.value=r.items.map(w=>({label:w.login,value:w.id})))}catch{done(()=>{})}}
async function copy(){try{await navigator.clipboard.writeText(link.value);q.notify({type:'positive',message:t('Copied to clipboard')})}catch{error.value=t('Unable to copy. Select the text manually.')}}
watch(()=>[section.value,action.value,props.route?.id,activeOrganization.value].join(':'),load,{immediate:true})
</script>

<template>
  <q-page class="q-pa-md inventory-page">
    <div class="page-heading">
      <h1>{{title}}</h1>
      <div v-if="!listing" class="page-actions"><q-btn flat no-caps icon="arrow_back" :label="t('Back to list')" :href="back" :disable="busy" /></div>
    </div>
    <q-banner v-if="error" class="error-banner rounded-borders" role="alert">{{error}}</q-banner>
    <q-banner v-if="!current && !globalAdmin" class="q-mb-md">{{t('No organization access yet. Ask an administrator for an invitation.')}}</q-banner>
    <q-banner v-if="!allowed" class="q-mb-md">{{t('Your session expired or you do not have permission. Sign in again.')}}</q-banner>
    <template v-else-if="listing">
      <q-card flat bordered>
        <div class="panel-heading"><div><h2>{{section==='organizations'?sectionLabel:current?.name}}</h2><p>{{rows.length}} {{t('found')}}</p></div></div>
        <q-tabs v-if="section!=='organizations'" dense no-caps align="left" active-color="primary" indicator-color="primary" :model-value="section" class="q-px-md q-mb-md"><q-tab @click="navigate('members')" name="members" :label="t('Members')" /><q-tab @click="navigate('invitations')" name="invitations" :label="t('Invitations')" /></q-tabs>
        <div class="inventory-controls container-controls organization-controls"><div class="inventory-actions"><q-input v-model="search" outlined dense clearable :placeholder="t('Search')" :aria-label="t('Search')" class="search-input"><template #prepend><q-icon name="search" size="21px" /></template></q-input><q-btn flat no-caps color="primary" icon="filter_alt_off" :label="t('Clear all filters')" :disable="!search" @click="search=''" /><div class="page-actions"><q-btn v-if="section==='organizations' && globalAdmin" unelevated no-caps color="primary" icon="add" :label="t('Create')" href="#/organizations/new" />
          <q-btn v-if="section==='invitations' && admin" unelevated no-caps color="primary" icon="add" :label="t('Generate invitation')" href="#/organizations/invitations/new" />
          <q-btn v-if="section!=='organizations'" flat no-caps icon="arrow_back" :label="t('Organizations')" href="#/organizations" />
          <q-btn unelevated no-caps color="primary" icon="refresh" :label="t('Refresh')" :loading="loading" @click="refresh" /></div></div></div>
        <q-table flat class="inventory-table" :rows="rows" :columns="columns" :filter="search" row-key="id" :loading="loading" :pagination="{rowsPerPage:10}">
          <template #body-cell-name="slot"><q-td :props="slot"><button v-if="section==='organizations'" class="table-link" @click="emit('select',slot.row.id,'#/workspaces')">{{slot.value}}</button><span v-else>{{slot.value}}</span></q-td></template>
          <template #body-cell-role="slot"><q-td :props="slot">{{slot.value}}<small v-if="section==='members' && protectedMember(slot.row)" class="member-protection">{{t('Last administrator')}}</small></q-td></template>
          <template #body-cell-action="slot"><q-td :props="slot">
            <template v-if="section==='organizations'">
              <template v-if="globalAdmin || slot.row.role==='admin'">
                <q-btn flat round dense icon="group" :aria-label="t('Members')" @click="open(slot.row,'members')"><q-tooltip>{{t('Members')}}</q-tooltip></q-btn>
                <q-btn flat round dense icon="mail_outline" :aria-label="t('Invitations')" @click="open(slot.row,'invitations')"><q-tooltip>{{t('Invitations')}}</q-tooltip></q-btn>
                <q-btn flat round dense icon="edit" :aria-label="t('Edit organization')" @click="open(slot.row,'edit')"><q-tooltip>{{t('Edit')}}</q-tooltip></q-btn>
              </template>
              <q-btn v-if="globalAdmin" flat round dense icon="more_vert" :aria-label="t('More actions')"><q-menu auto-close><q-list><q-item clickable @click="open(slot.row,'transfer')"><q-item-section>{{t('Transfer workspace')}}</q-item-section></q-item><q-item clickable @click="open(slot.row,'delete')"><q-item-section class="text-negative">{{t('Delete organization')}}</q-item-section></q-item></q-list></q-menu></q-btn>
            </template>
            <template v-else-if="section==='members'"><span class="member-actions"><q-btn flat round dense icon="edit" :aria-label="t('Edit member')" :disable="protectedMember(slot.row)" :href="protectedMember(slot.row)?undefined:`#/organizations/members/${slot.row.id}/edit`" /><q-btn flat round dense color="negative" icon="person_remove" :aria-label="t('Remove member')" :disable="protectedMember(slot.row)" :href="protectedMember(slot.row)?undefined:`#/organizations/members/${slot.row.id}/delete`" /><q-tooltip v-if="protectedMember(slot.row)">{{t('Promote another administrator before removing or changing this member.')}}</q-tooltip></span></template>
            <q-btn v-else-if="!slot.row.used_at && !slot.row.revoked_at" flat round dense color="negative" icon="block" :aria-label="t('Revoke invitation')" :href="`#/organizations/invitations/${slot.row.id}/revoke`" />
          </q-td></template>
          <template #no-data><div class="empty-state"><q-icon name="search_off" size="36px" /><h3>{{t('No records in this selection')}}</h3></div></template>
        </q-table>
      </q-card>
    </template>
    <q-card v-else flat bordered class="organization-form">
      <q-card-section v-if="loading" class="q-pa-xl text-center"><q-spinner color="primary" /></q-card-section>
      <q-form v-else @submit="submit" class="q-pa-lg q-gutter-y-md">
        <q-banner v-if="memberProtected" class="bg-orange-1 text-dark">{{t('Promote another administrator before removing or changing this member.')}}</q-banner>
        <template v-if="link"><h2 class="text-h6 q-ma-none">{{t('Invitation link')}}</h2><p>{{t('Copy this link now. It will not be shown again.')}}</p><q-input :model-value="link" outlined readonly type="textarea" autogrow :label="t('Invitation link')" /><q-btn unelevated no-caps color="primary" icon="content_copy" :label="t('Copy link')" @click="copy" /><q-btn flat no-caps :label="t('Back to list')" :href="back" /></template>
        <template v-else>
          <p v-if="current && action!=='new'" class="text-grey-7 q-mt-none">{{current.name}}</p>
          <q-input v-if="section==='organizations' && ['new','edit'].includes(action)" v-model="name" outlined autofocus :label="t('Organization name')" :rules="[required]" />
          <template v-if="action==='transfer'"><p>{{t('Transferring a workspace revokes its daemon credentials. Provision them again in the destination organization.')}}</p><q-select v-model="workspace" :options="workspaces" emit-value map-options use-input @filter="searchWorkspace" outlined :label="t('Workspace')" :rules="[required]" /><q-select v-model="destination" :options="organizationChoices.filter(r=>r.id!==current?.id).map(r=>({label:r.name,value:r.id}))" emit-value map-options outlined :label="t('Destination organization')" :rules="[required]" /></template>
          <template v-if="section==='invitations' && action==='new'"><p>{{t('Generate a link and send it through any channel. Valid for seven days.')}}</p><q-input v-model="email" outlined type="email" autofocus :label="t('Email')" :rules="[required]" /><q-select v-model="role" :options="roles" emit-value map-options outlined :label="t('Permission')" /></template>
          <template v-if="section==='members' && action==='edit' && selected"><p>{{selected.name || selected.email}}</p><q-select v-model="role" :options="roles" :disable="memberProtected" emit-value map-options outlined :label="t('Permission')" /></template>
          <template v-if="['delete','revoke'].includes(action)"><h2 class="text-h6 q-my-none">{{selected?.email || current?.name}}</h2><p>{{t(action==='revoke'?'This invitation will no longer grant access.':section==='members'?'This member will lose access to this organization.':'This deletion is permanent.')}}</p></template>
          <div class="row justify-end q-gutter-sm q-pt-md"><q-btn flat no-caps :label="t('Cancel')" :href="back" :disable="busy" /><q-btn v-if="!loading && (section==='organizations' || action==='new' || selected)" type="submit" :disable="memberProtected" unelevated no-caps :color="['delete','revoke'].includes(action)?'negative':'primary'" :icon="['delete','revoke'].includes(action)?'block':'save'" :label="t(action==='new' && section==='invitations'?'Generate invitation':action==='transfer'?'Transfer workspace':action==='delete'?'Delete permanently':action==='revoke'?'Revoke':'Save')" :loading="busy" /></div>
        </template>
      </q-form>
    </q-card>
  </q-page>
</template>

<style scoped>
.member-actions{display:inline-flex}.member-protection{display:block;font-size:11px;color:#71717a;margin-top:4px}
.organization-controls{padding-top:12px}
.organization-form{max-width:760px;margin:0 auto 24px}
.organization-form p,.organization-form h2{overflow-wrap:anywhere}
</style>
