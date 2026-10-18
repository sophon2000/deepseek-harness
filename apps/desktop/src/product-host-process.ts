/** One backend boundary that starts product services before the DSH Host. */

import { join } from 'node:path'
import {
  DesktopHostProcess,
  DesktopHostUncleanExitError,
  type DesktopHostReady,
  type DesktopQuitInspection,
} from './host-process.ts'
import { DesktopProductProcess, DesktopProductUncleanExitError } from './product-process.ts'
import type { DesktopRuntimeProduct } from './desktop-product.ts'
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'

/** Confirm all children exited while refusing an update after any unsuccessful teardown. */
export function isDesktopBackendUncleanExit(error: unknown): error is Error {
  return error instanceof DesktopHostUncleanExitError || error instanceof DesktopProductUncleanExitError
    || (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(isDesktopBackendUncleanExit))
}

/** DSH Host plus an optional product service under one ordered lifecycle. */
export class DesktopProductHostProcess {
  private productProcess: DesktopProductProcess | undefined
  private hostProcess: DesktopHostProcess | undefined
  private stopped = false
  private stopPromise: Promise<void> | undefined

  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly productRuntimeDir: string,
    private readonly projectDir: string,
    private readonly productsDataRoot: string,
    private readonly product: DesktopRuntimeProduct | undefined,
    private readonly inspectPort?: number,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
    private readonly primaryRuntime?: string,
    private readonly packageManager?: { readonly pnpm: string; readonly nodeBin: string },
    private readonly onPlatformSession?: (session: PlatformSession | null) => void,
  ) {}

  /** Start the product service first so the Host receives its ready environment. */
  async start(): Promise<DesktopHostReady> {
    if (this.stopped) throw new Error('desktop product backend is stopped')
    try {
      let hostEnvironment = this.environment
      if (this.product?.service !== undefined) {
        const productProcess = new DesktopProductProcess(
          this.node, this.productRuntimeDir, this.product, join(this.productsDataRoot, this.product.id),
          this.environment, this.onFailure, this.product.service.readyTimeoutMs,
        )
        this.productProcess = productProcess
        const ready = await productProcess.start()
        hostEnvironment = { ...this.environment, ...ready.environment }
      }
      // stop() can cancel the backend while the product service starts.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this.stopped) throw new Error('desktop product backend startup was cancelled')
      const host = new DesktopHostProcess(
        this.node, this.runtimeDir, this.projectDir, this.inspectPort, hostEnvironment, this.onFailure,
        this.primaryRuntime, this.packageManager, this.onPlatformSession,
      )
      this.hostProcess = host
      return await host.start()
    } catch (error) {
      try { await this.stop() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'desktop product backend startup and cleanup failed')
      }
      throw error
    }
  }

  /** Stop the Host before its product service; preserve one Error or aggregate multiple failures. */
  stop(requireGraceful = false): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise
    this.stopped = true
    this.stopPromise = this.stopChildren(requireGraceful)
    return this.stopPromise
  }

  private async stopChildren(requireGraceful: boolean): Promise<void> {
    const results = await Promise.allSettled([this.hostProcess?.stop(requireGraceful)])
    const productResult = await Promise.allSettled([this.productProcess?.stop(requireGraceful)])
    this.hostProcess = undefined
    this.productProcess = undefined
    const failures = [...results, ...productResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason instanceof Error ? result.reason : new Error(String(result.reason)))
    if (failures.length > 1) throw new AggregateError(failures, 'desktop product backend cleanup failed')
    const [failure] = failures
    if (failure !== undefined) throw failure
  }

  /** Forward update task inspection and admission control to the DSH Host. */
  updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean> {
    const host = this.hostProcess
    if (host === undefined) return Promise.reject(new Error('dsh desktop host is unavailable'))
    return host.updateTasks(action)
  }

  /** Forward quit-safety inspection to the DSH Host. */
  inspectQuit(): Promise<DesktopQuitInspection> {
    const host = this.hostProcess
    if (host === undefined) return Promise.reject(new Error('dsh desktop host is unavailable'))
    return host.inspectQuit()
  }
}
