/** Lifecycle for a signed product service or an exiting resource preflight. */

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
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => (
      name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name)
      && !/^(?:npm|pnpm|corepack)_/iu.test(name)
    ))),
    ELECTRON_RUN_AS_NODE: '1',
  }
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

/** The product has exited, but its unsuccessful teardown forbids update installation. */
export class DesktopProductUncleanExitError extends Error {}

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
  private readyTimer: ReturnType<typeof setTimeout> | undefined
  private stopPromise: Promise<void> | undefined
  private uncleanExit: DesktopProductUncleanExitError | undefined
  private prepared: DesktopProductReady | undefined

  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly product: DesktopRuntimeProduct,
    private readonly dataRoot: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
    private readonly readyTimeoutMs = 30_000,
    private readonly mode: 'service' | 'preflight' = 'service',
  ) {
    if (product[mode] === undefined) throw new Error(`desktop product ${mode} is not declared`)
    if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1) {
      throw new Error('desktop product service ready timeout must be a positive integer')
    }
  }

  /** A service resolves at ready; preflight additionally requires clean process and stdio closure. */
  async start(): Promise<DesktopProductReady> {
    if (this.stopping) throw new Error('desktop product service is stopped')
    if (this.child !== undefined) return this.readyPromise
    const service = this.product[this.mode]
    if (service === undefined) throw new Error('desktop product service is not declared')
    const resourcesRoot = runtimePath(this.runtimeDir, this.product.resourcesRoot)
    const entrypoint = runtimePath(resourcesRoot, service.entrypoint)
    await mkdir(this.dataRoot, { recursive: true })
    // stop() can close the process while its data directory is being prepared.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.stopping) throw new Error('desktop product service startup was cancelled')
    const child = spawn(this.node, [entrypoint, '--runtime-root', resourcesRoot, '--data-root', this.dataRoot], {
      cwd: this.dataRoot,
      env: cleanEnvironment(this.environment),
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
    })
    this.child = child
    this.readyTimer = setTimeout(() => {
      this.fail(new Error(`desktop product service did not become ready within ${String(this.readyTimeoutMs)} ms`))
      child.kill('SIGTERM')
    }, this.readyTimeoutMs)
    this.readyTimer.unref()
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR)
    })
    child.on('message', (message: unknown) => {
      const environment = readyEnvironment(message, service.exportedEnvironment)
      if (environment !== undefined) {
        if (this.mode === 'preflight' && this.prepared !== undefined) {
          this.fail(new Error('desktop product sent duplicate readiness'))
          child.kill('SIGTERM')
          return
        }
        this.prepared = { environment }
        if (this.mode === 'service') {
          this.clearReadyTimer()
          this.readyResolve(this.prepared)
        }
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
        if (!this.stopping && this.mode === 'preflight' && code === 0 && signal === null && this.prepared !== undefined) {
          this.clearReadyTimer()
          this.readyResolve(this.prepared)
          resolve()
          return
        }
        const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
        if (!this.stopping) {
          this.fail(new Error(`desktop product service stopped (code=${String(code)}, signal=${String(signal)})${suffix}`))
        }
        resolve()
      })
    })
    return this.readyPromise
  }

  /** Stop and await exit; an update additionally requires a successful cooperative shutdown. */
  stop(requireGraceful = false): Promise<void> {
    if (this.stopPromise === undefined) {
      this.stopping = true
      this.clearReadyTimer()
      this.stopPromise = this.stopChild()
    }
    return requireGraceful ? this.stopPromise.then(() => {
      if (this.uncleanExit !== undefined) throw this.uncleanExit
    }) : this.stopPromise
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.readyReject(new Error('desktop product service startup was cancelled'))
    let forced = false
    const terminate = (): void => { forced = true; child.kill('SIGTERM') }
    if (child.connected) child.send({ type: 'shutdown' }, (error) => {
      if (error !== null) terminate()
    })
    const exited = this.exitPromise ?? Promise.resolve()
    if (!await exitsWithin(exited, 10_000)) terminate()
    if (!await exitsWithin(exited, 5_000)) {
      child.kill('SIGKILL')
      if (!await exitsWithin(exited, 5_000)) throw new Error('desktop product service did not exit after SIGKILL')
    }
    this.child = undefined
    // Termination can be requested by the IPC callback while awaiting child exit.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (forced || child.exitCode !== 0 || child.signalCode !== null) {
      // Only exit metadata reaches update diagnostics; product stderr can contain credentials.
      this.uncleanExit = new DesktopProductUncleanExitError(`desktop update: product did not complete graceful teardown (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}, forced termination ${String(forced)})`)
    }
  }

  private fail(error: Error): void {
    this.clearReadyTimer()
    this.readyReject(error)
    if (this.failureReported || this.stopping) return
    this.failureReported = true
    this.onFailure?.(error)
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== undefined) clearTimeout(this.readyTimer)
    this.readyTimer = undefined
  }
}
