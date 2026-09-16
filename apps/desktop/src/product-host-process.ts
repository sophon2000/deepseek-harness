/** One backend boundary that starts product services before the DSH Host. */

import { join } from 'node:path'
import { DesktopHostProcess, type DesktopHostReady } from './host-process.ts'
import { DesktopProductProcess } from './product-process.ts'
import type { DesktopRuntimeProduct } from './desktop-product.ts'

/** DSH Host plus an optional product service under one ordered lifecycle. */
export class DesktopProductHostProcess {
  private productProcess: DesktopProductProcess | undefined
  private hostProcess: DesktopHostProcess | undefined

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
    private readonly profileResolution: 'link' | 'runtime' = 'link',
    private readonly packageManager?: { readonly pnpm: string; readonly nodeBin: string },
  ) {}

  /** Start the product service first so the Host receives its ready environment. */
  async start(): Promise<DesktopHostReady> {
    try {
      let hostEnvironment = this.environment
      if (this.product?.service !== undefined) {
        const productProcess = new DesktopProductProcess(
          this.node, this.productRuntimeDir, this.product, join(this.productsDataRoot, this.product.id),
          this.environment, this.onFailure,
        )
        this.productProcess = productProcess
        const ready = await productProcess.start()
        hostEnvironment = { ...this.environment, ...ready.environment }
      }
      const host = new DesktopHostProcess(
        this.node, this.runtimeDir, this.projectDir, this.inspectPort, hostEnvironment, this.onFailure,
        this.primaryRuntime, this.profileResolution, this.packageManager,
      )
      this.hostProcess = host
      return await host.start()
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  /** Stop the Host before the product service it depends on. */
  async stop(requireGraceful = false): Promise<void> {
    const results = await Promise.allSettled([this.hostProcess?.stop(requireGraceful)])
    const productResult = await Promise.allSettled([this.productProcess?.stop()])
    this.hostProcess = undefined
    this.productProcess = undefined
    const failures = [...results, ...productResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'desktop product backend cleanup failed')
  }

  /** Forward update task inspection and admission control to the DSH Host. */
  updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean> {
    const host = this.hostProcess
    if (host === undefined) return Promise.reject(new Error('dsh desktop host is unavailable'))
    return host.updateTasks(action)
  }
}
