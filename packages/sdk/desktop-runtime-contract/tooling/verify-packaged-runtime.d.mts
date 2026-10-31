/** electron-builder context required by packaged runtime verification. */
export interface PackagedRuntimeContext {
  readonly appOutDir: string
  readonly packager: {
    getResourcesDir(appOutDir: string): string
  }
}

/** Reject a package whose child-process runtime was omitted or partially copied. */
export function verifyPackagedDesktopRuntime(context: PackagedRuntimeContext): void
