import test from 'node:test'
import assert from 'node:assert/strict'
import { repositoryHref, repositoryLabel, versionControlLabel } from '../apps/web/src/project-repository.ts'

test('repository links accept browser URLs without embedded credentials', () => {
  assert.equal(repositoryHref('https://git.example.com/team/project'), 'https://git.example.com/team/project')
  assert.equal(repositoryLabel('https://git.example.com/team/project/'), 'git.example.com/team/project')
  for (const url of ['', 'javascript:alert(1)', 'git@git.example.com:team/project', 'https://user:token@git.example.com/repo', 'https://git.example.com/repo?token=secret', 'https://git.example.com/repo#token', 'https://git.example.com\\@evil.example/repo']) assert.equal(repositoryHref(url), '', url)
})

test('missing repository information is not classified as unversioned', () => {
  assert.equal(versionControlLabel(), 'To confirm')
  assert.equal(versionControlLabel('unknown'), 'To confirm')
  assert.equal(versionControlLabel('versioned'), 'Versioned')
  assert.equal(versionControlLabel('unversioned'), 'Not versioned')
})
