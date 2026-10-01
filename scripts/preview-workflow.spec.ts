import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/build-preview-cloudflare.yml'), 'utf8')) as {
  on: unknown
  permissions: unknown
  concurrency: unknown
  env: Record<string, string>
  jobs: Record<'preview', {
    'runs-on': string
    if?: string
    'continue-on-error'?: boolean
    steps: Array<{ name?: string; uses?: string; run?: string; if?: string; 'continue-on-error'?: boolean; with?: Record<string, unknown>; env?: Record<string, string> }>
  }>
}
const preview = workflow.jobs.preview
const operationalRepository = 'deepseek-harness/deepseek-harness'
const deploymentStepNames = ['Upload to Cloudflare Pages', 'Verify the protected deployment serves the image', 'Comment the preview URL']
const deploymentGuard = "github.repository == 'deepseek-harness/deepseek-harness' && "
  + "github.event.repository.full_name == 'deepseek-harness/deepseek-harness' && "
  + 'github.event.pull_request.head.repo.full_name == github.repository && '
  + "github.event.pull_request.user.login != 'dependabot[bot]'"

describe('PR preview workflow', () => {
  it('keeps every PR author on the selected GitHub-hosted runner', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['preview'])
    expect(preview['runs-on']).toBe('ubuntu-24.04')
    expect(workflow.on).toEqual({ pull_request: { types: ['opened', 'synchronize', 'reopened'] } })
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' })
    expect(preview.steps.find(step => step.uses === 'actions/checkout@v6')?.with).toEqual({ 'persist-credentials': false })
  })

  it('keeps the immutable full build and restore-only dependency cache', () => {
    expect(workflow.env.PRIMARY_NODE_VERSION).toBe('24')
    expect(workflow.env.DSH_TELEMETRY_DISABLED).toBe('1')
    const commands = preview.steps.map(step => step.run)
    expect(commands).toContain('pnpm install --frozen-lockfile')
    expect(commands).toContain('pnpm run build')
    expect(commands).toContain('pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview')
    expect(commands.indexOf('pnpm run build')).toBeLessThan(commands.indexOf('pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview'))
    expect(preview.steps.filter(step => step.uses?.startsWith('actions/cache'))).toHaveLength(1)
    expect(preview.steps.find(step => step.uses === 'actions/cache/restore@v4')?.with).toMatchObject({
      key: "${{ runner.os }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}",
    })
  })

  it('builds every PR unconditionally and guards only the three remote operations', () => {
    expect(preview.if).toBeUndefined()
    expect(preview.steps.filter(step => step.if !== undefined).map(step => step.name)).toEqual(deploymentStepNames)
    for (const step of preview.steps) {
      if (step.name && deploymentStepNames.includes(step.name)) {
        expect(step.if, step.name).toBe(deploymentGuard)
      } else {
        expect(step.if, step.name ?? step.uses).toBeUndefined()
      }
    }
  })

  it.each(deploymentStepNames)('%s requires the configured repository, a same-repository head, and a non-Dependabot author', (name) => {
    const step = preview.steps.find(step => step.name === name)!
    if (typeof step.if !== 'string') throw new TypeError(`${name} must define a deployment condition`)
    for (const [repository, eventRepository, headRepository, login, expected] of [
      [operationalRepository, operationalRepository, operationalRepository, 'maintainer', true],
      ['sophon2000/deepseek-harness', 'sophon2000/deepseek-harness', 'sophon2000/deepseek-harness', 'maintainer', false],
      ['deepseek-ai/deepseek-harness', 'deepseek-ai/deepseek-harness', 'deepseek-ai/deepseek-harness', 'maintainer', false],
      ['another-owner/deepseek-harness', 'another-owner/deepseek-harness', 'another-owner/deepseek-harness', 'maintainer', false],
      [operationalRepository, 'sophon2000/deepseek-harness', operationalRepository, 'maintainer', false],
      ['sophon2000/deepseek-harness', operationalRepository, 'sophon2000/deepseek-harness', 'maintainer', false],
      [operationalRepository, operationalRepository, 'sophon2000/deepseek-harness', 'maintainer', false],
      [operationalRepository, operationalRepository, operationalRepository, 'dependabot[bot]', false],
      [operationalRepository, '', operationalRepository, 'maintainer', false],
      ['', operationalRepository, operationalRepository, 'maintainer', false],
      [operationalRepository, operationalRepository, '', 'maintainer', false],
    ] as const) {
      expect(runInNewContext(step.if, {
        github: {
          repository,
          event: {
            repository: { full_name: eventRepository },
            pull_request: { head: { repo: { full_name: headRepository } }, user: { login } },
          },
        },
      }, { timeout: 1000 }), `${repository} event=${eventRepository} head=${headRepository} author=${login}`).toBe(expected)
    }
  })

  it('keeps build, deployment, and remote verification failures blocking', () => {
    expect(preview['continue-on-error']).toBeUndefined()
    for (const step of preview.steps) {
      expect(step['continue-on-error'], step.name ?? step.uses).toBeUndefined()
      // No status-check function overrides Actions' implicit success() gate.
      expect(step.if ?? '').not.toMatch(/\b(?:always|cancelled|failure|success)\s*\(/)
    }
    const deploy = preview.steps.find(step => step.name === 'Upload to Cloudflare Pages')!
    const verify = preview.steps.find(step => step.name === 'Verify the protected deployment serves the image')!
    const comment = preview.steps.find(step => step.name === 'Comment the preview URL')!
    expect(preview.steps.indexOf(deploy)).toBeLessThan(preview.steps.indexOf(verify))
    expect(preview.steps.indexOf(verify)).toBeLessThan(preview.steps.indexOf(comment))
    expect(deploy.run).not.toMatch(/\|\|\s*(?:true|:)/)
    expect(verify.run?.match(/exit 1/g)).toHaveLength(3)
  })

  it('retains per-PR deployment, protected image verification, and idempotent URL comments', () => {
    expect(workflow.concurrency).toEqual({
      group: 'build-preview-cloudflare-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    })
    expect(workflow.env.CF_PROJECT).toBe('dsh-build-preview')
    const shape = preview.steps.find(step => step.name === 'Shape the upload')!
    expect(shape.run).toContain("find apps/web/dist -name '*.map' -delete")
    expect(shape.run).toContain('cp apps/web/dist/preview.html apps/web/dist/index.html')
    const deploy = preview.steps.find(step => step.name === 'Upload to Cloudflare Pages')!
    expect(deploy.run).toContain('npx --yes wrangler@4 pages deploy apps/web/dist')
    expect(deploy.run).toContain('--branch "pr-${{ github.event.pull_request.number }}"')
    const verify = preview.steps.find(step => step.name === 'Verify the protected deployment serves the image')!
    expect(verify.run).toContain('/preview/vfs-image.tar.gz')
    expect(verify.run).toContain('"$code" != "200"')
    expect(verify.run).toContain('content-encoding:')
    expect(verify.run).toContain('"$magic" != "1f8b"')
    expect(verify.env?.CF_ACCESS_CLIENT_SECRET).toBe('${{ secrets.CF_ACCESS_CLIENT_SECRET }}')
    const comment = preview.steps.find(step => step.name === 'Comment the preview URL')!
    expect(comment.run).toContain('<!-- dsh-preview-url -->')
    expect(comment.run).toContain('gh pr comment "$PR" --body-file -')
  })
})
