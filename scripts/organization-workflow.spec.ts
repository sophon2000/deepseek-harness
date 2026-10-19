import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const operationalRepository = 'deepseek-harness/deepseek-harness'
const publicUpstream = 'deepseek-ai/deepseek-harness'

describe('Organization workflow repository guards', () => {
  it.each([
    ['issue-policy.yml', 'policy', 'pull_request', { action: 'opened' }],
    ['issue-lifecycle.yml', 'lifecycle', 'issues', { action: 'opened' }],
    ['weighted-approval.yml', 'publish-status', 'pull_request_target', { pull_request: { state: 'open' } }],
    ['weighted-approval-review-event.yml', 'record-review-event', 'pull_request_review', { pull_request: { state: 'open' } }],
  ] as const)('%s requires both the configured repository and its event repository', (file, jobName, eventName, event) => {
    const job = loadJob(file, jobName)
    for (const [repository, eventRepository, expected] of [
      [operationalRepository, operationalRepository, true],
      ['sophon2000/deepseek-harness', 'sophon2000/deepseek-harness', false],
      [publicUpstream, publicUpstream, false],
      ['another-owner/deepseek-harness', 'another-owner/deepseek-harness', false],
      [operationalRepository, 'sophon2000/deepseek-harness', false],
      ['sophon2000/deepseek-harness', operationalRepository, false],
      [operationalRepository, '', false],
      ['', operationalRepository, false],
    ] as const) {
      expect(evaluateJobCondition(job.if, {
        repository,
        event_name: eventName,
        event: { ...event, repository: { full_name: eventRepository } },
      }), `${repository} event.repository=${eventRepository}`).toBe(expected)
    }
  })

  it.each([
    ['issue-policy.yml', 'policy', 'pull_request', { action: 'opened' }, true],
    ['issue-policy.yml', 'policy', 'pull_request_review', { review: { state: 'approved' } }, true],
    ['issue-lifecycle.yml', 'lifecycle', 'issues', { action: 'opened' }, true],
    ['issue-lifecycle.yml', 'lifecycle', 'pull_request', { action: 'opened' }, true],
    ['issue-lifecycle.yml', 'lifecycle', 'pull_request', { action: 'edited', changes: { body: { from: 'old body' } } }, true],
    ['issue-lifecycle.yml', 'lifecycle', 'pull_request', { action: 'edited', changes: { title: { from: 'old title' } } }, false],
    ['issue-lifecycle.yml', 'lifecycle', 'pull_request_review', { review: { state: 'changes_requested' } }, true],
    ['issue-lifecycle.yml', 'lifecycle', 'pull_request_review', { review: { state: 'approved' } }, false],
    ['issue-lifecycle.yml', 'lifecycle', 'pull_request_review', { review: { state: 'commented' } }, false],
    ['weighted-approval.yml', 'publish-status', 'pull_request_target', { pull_request: { state: 'open' } }, true],
    ['weighted-approval.yml', 'publish-status', 'pull_request_target', { pull_request: { state: 'closed' } }, false],
    ['weighted-approval.yml', 'publish-status', 'workflow_run', { workflow_run: { conclusion: 'success' } }, true],
    ['weighted-approval.yml', 'publish-status', 'workflow_run', { workflow_run: { conclusion: 'failure' } }, false],
    ['weighted-approval.yml', 'publish-status', 'workflow_run', { workflow_run: { conclusion: 'cancelled' } }, false],
    ['weighted-approval.yml', 'publish-status', 'workflow_run', { workflow_run: { conclusion: 'skipped' } }, false],
    ['weighted-approval.yml', 'publish-status', 'issue_comment', { issue: { pull_request: {}, state: 'open' }, comment: { body: '/delegate @maintainer' } }, true],
    ['weighted-approval.yml', 'publish-status', 'issue_comment', { issue: { pull_request: {}, state: 'open' }, comment: { body: 'edited comment' }, changes: { body: { from: '/delegate @maintainer' } } }, true],
    ['weighted-approval.yml', 'publish-status', 'issue_comment', { issue: { pull_request: {}, state: 'open' }, comment: { body: 'ordinary comment' }, changes: { body: {} } }, false],
    ['weighted-approval.yml', 'publish-status', 'issue_comment', { issue: { pull_request: {}, state: 'closed' }, comment: { body: '/delegate @maintainer' } }, false],
    ['weighted-approval.yml', 'publish-status', 'issue_comment', { issue: { pull_request: false, state: 'open' }, comment: { body: '/delegate @maintainer' } }, false],
    ['weighted-approval-review-event.yml', 'record-review-event', 'pull_request_review', { pull_request: { state: 'open' } }, true],
    ['weighted-approval-review-event.yml', 'record-review-event', 'pull_request_review', { pull_request: { state: 'closed' } }, false],
  ] as const)('%s retains %s eligibility for %s %j', (file, jobName, eventName, event, expected) => {
    const job = loadJob(file, jobName)
    expect(evaluateJobCondition(job.if, {
      repository: operationalRepository,
      event_name: eventName,
      event: { ...event, repository: { full_name: operationalRepository } },
    })).toBe(expected)
  })
})

function evaluateJobCondition(condition: unknown, github: Record<string, unknown>): unknown {
  if (typeof condition !== 'string') throw new TypeError('Job condition must be a string')
  return runInNewContext(condition, {
    github,
    contains: (value: unknown, search: string) => typeof value === 'string' && value.toLowerCase().includes(search.toLowerCase()),
  }, { timeout: 1000 })
}

function loadJob(file: string, name: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows', file), 'utf8'))
  if (!isRecord(workflow) || !isRecord(workflow.jobs) || !isRecord(workflow.jobs[name])) {
    throw new TypeError(`${file} must define the ${name} job`)
  }
  return workflow.jobs[name]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
