<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n'
import { repositoryHref, repositoryLabel, type ProjectRepository } from '../project-repository'
const props = withDefaults(defineProps<{project:ProjectRepository, inline?:boolean}>(),{inline:false})
const href = computed(() => repositoryHref(props.project.source_repository_url))
const hasDetails = computed(() => Boolean(href.value || props.project.deployment_branch || (props.inline && props.project.deployment_template)))
</script>

<template>
  <div v-if="hasDetails" class="project-repository" :class="{'project-repository--inline':inline}">
    <a v-if="href" :href="href" :title="project.source_repository_url" target="_blank" rel="noopener noreferrer" class="repository-link text-primary" @click.stop @auxclick.stop><q-icon name="code" size="16px"/><span>{{repositoryLabel(project.source_repository_url)}}</span><q-icon name="open_in_new" size="13px"/></a>
    <span v-if="project.deployment_branch" class="repository-branch" :title="`${t('Deployment branch')}: ${project.deployment_branch}`"><q-icon name="account_tree" size="14px"/><span>{{project.deployment_branch}}</span></span>
    <span v-if="inline && project.deployment_template" class="repository-template" :title="t('Deployment template')"><q-icon name="description" size="14px"/><span>{{project.deployment_template}}</span></span>
  </div>
</template>

<style scoped>
.project-repository {display:flex;flex-direction:column;gap:4px;min-width:0;max-width:360px;font-size:13px}
.repository-link,.repository-branch,.repository-template {display:flex;align-items:center;gap:5px;min-width:0}
.repository-link {text-decoration:none;line-height:20px}
.repository-link:hover {text-decoration:underline}
.repository-link span,.repository-branch span {overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.project-repository .q-icon {flex:none}
.repository-branch,.repository-template {color:var(--i7y-muted,#71717a);font-size:12px;line-height:18px}
.project-repository--inline {max-width:none;flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px 20px}
.project-repository--inline .repository-link {max-width:100%}
.project-repository--inline .repository-template span {overflow-wrap:anywhere;min-width:0}
@media(max-width:599px) {
  .project-repository--inline {gap:6px 16px}
  .project-repository--inline .repository-link,.project-repository--inline .repository-template {flex-basis:100%}
}
</style>
