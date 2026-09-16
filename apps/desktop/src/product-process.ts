/** Generic lifecycle for one signed product-owned background service. */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { runtimePath } from './runtime-tree.ts'
import type { DesktopRuntimeProduct } from './desktop-product.ts'

const MAX_STDERR = 64 * 1024

function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  return Promise.race([exit.then(() => true), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function cleanEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => (
    name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name)
    && !/^(?:npm|pnpm|corepack)_/iu.test(name)
  )))
}

function readyEnvironment(message: unknown, allowed: readonly string[]): NodeJS.ProcessEnv | undefined {
  if (typeof message !== 'object' || message === null || !('type' in message)) return undefined
  const candidate = message as Record<string, unknown>
  if (candidate.type !== 'ready' || typeof candidate.environment !== 'object'
    || candidate.environment === null || Array.isArray(candidate.environment)) return undefined
  const environment = candidate.environment as Record<string, unknown>
  const names = Object.keys(environment).sort()
  if (JSON.stringify(names) !== JSON.stringify([...allowed].sort())) return undefined
  if (!Object.values(environment).every(value => typeof value === 'string'
    && value.length > 0 && !/[\0\r\n]/u.test(value))) return undefined
  return environment as NodeJS.ProcessEnv
}

/** Environment supplied by a ready product service to the DSH Host only. */
export interface DesktopProductReady {
  readonly environment: NodeJS.ProcessEnv
}

/** Product service launched from an integrity-checked Desktop runtime. */
export class DesktopProductProcess {
  private child: ChildProcess | undefined
  private exitPromise: Promise<void> | undefined
  private readyResolve!: (ready: DesktopProductReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<DesktopProductReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private stderr = ''
  private stopping = false
  private failureReported = false

  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly product: DesktopRuntimeProduct,
    private readonly dataRoot: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
  ) {
    if (product.service === undefined) throw new Error('desktop product service is not declared')
  }

  /** Start once and resolve after the product reports its exact allowlisted Host environment. */
  async start(): Promise<DesktopProductReady> {
    if (this.child !== undefined) return this.readyPromise
    const service = this.product.service
    if (service === undefined) throw new Error('desktop product service is not declared')
    const resourcesRoot = runtimePath(this.runtimeDir, this.product.resourcesRoot)
    const entrypoint = runtimePath(resourcesRoot, service.entrypoint)
    await mkdir(this.dataRoot, { recursive: true })
    const child = spawn(this.node, [entrypoint, '--runtime-root', resourcesRoot, '--data-root', this.dataRoot], {
      cwd: this.dataRoot,
      env: cleanEnvironment(this.environment),
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR)
    })
    child.on('message', (message: unknown) => {
      const environment = readyEnvironment(message, service.exportedEnvironment)
      if (environment !== undefined) {
        this.readyResolve({ environment })
        return
      }
      if (typeof message === 'object' && message !== null && 'type' in message
        && (message as Record<string, unknown>).type === 'fatal'
        && typeof (message as Record<string, unknown>).message === 'string') {
        this.fail(new Error(`desktop product service failed: ${String((message as Record<string, unknown>).message)}`))
        return
      }
      this.fail(new Error('desktop product service sent an invalid IPC event'))
      child.kill('SIGTERM')
    })
    child.once('error', (error) => { this.fail(error) })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('close', (code, signal) => {
        const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
        if (!this.stopping) {
          this.fail(new Error(`desktop product service stopped (code=${String(code)}, signal=${String(signal)})${suffix}`))
        }
        resolve()
      })
    })
    return this.readyPromise
  }

  /** Stop cooperatively, then terminate a service that does not respond. */
  async stop(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    if (child.connected) child.send({ type: 'shutdown' })
    const exited = this.exitPromise ?? Promise.resolve()
    if (!await exitsWithin(exited, 10_000)) child.kill('SIGTERM')
    if (!await exitsWithin(exited, 5_000)) {
      child.kill('SIGKILL')
      if (!await exitsWithin(exited, 5_000)) throw new Error('desktop product service did not exit after SIGKILL')
    }
    this.child = undefined
  }

  private fail(error: Error): void {
    this.readyReject(error)
    if (this.failureReported || this.stopping) return
    this.failureReported = true
    this.onFailure?.(error)
  }
}
