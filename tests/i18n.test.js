import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { messages } from '../apps/web/src/messages.ts'

test('all interface messages exist in every language and use workspace terminology', () => {
  const source = ['App.vue','layouts/MainLayout.vue','components/ManagementPage.vue','components/ApiTokensPage.vue','components/TelemetryPage.vue','components/TelemetryTrend.vue','components/AgentInstallPage.vue','components/OrganizationsPage.vue','components/InvitationPage.vue','components/DesktopMcpPage.vue','components/DesktopApproval.vue','components/McpRequestReview.vue'].map(path => readFileSync(new URL(`../apps/web/src/${path}`, import.meta.url), 'utf8')).join('\n')
  const keys = [...source.matchAll(/\bt\('([^']+)'\)/g)].map(match => match[1])
  for (const language of ['en', 'pt-BR', 'uk']) {
    for (const key of keys) assert.ok(messages[language][key], `${language}: ${key}`)
    for (const value of Object.values(messages[language])) assert.doesNotMatch(value, /\baccounts?\b/i)
  }
  assert.doesNotMatch(source, /class="sidebar-footer"/)
})

test('MCP consent names both the signed-in user and organization in every language',()=>{
  const key='The client name is self-reported. Access stays within your selected account and organization.'
  const identities={en:/signed-in user/,'pt-BR':/usu\u00e1rio conectado/,uk:/користувачем, який увійшов у систему/}
  const organizations={en:/selected organization/,'pt-BR':/organiza\u00e7\u00e3o selecionada/,uk:/вибраною організацією/}
  for(const language of Object.keys(identities)){
    assert.match(messages[language][key],identities[language])
    assert.match(messages[language][key],organizations[language])
  }
})

test('every supported language has the same message catalog', () => {
  for (const language of ['pt-BR','uk']) assert.deepEqual(Object.keys(messages[language]).sort(),Object.keys(messages.en).sort())
})
