/** Product requirements received by the private Desktop Host launcher.
 * @param argument - JSON service-key array; omission retains ordinary startup.
 * @returns Validated unique service keys.
 */
export function parseDesktopRequiredServices(argument: string | undefined): readonly string[] {
  if (argument === undefined) return []
  const value: unknown = JSON.parse(argument)
  if (!Array.isArray(value) || value.length > 64
    || !value.every(key => typeof key === 'string' && /^[A-Za-z][A-Za-z0-9._-]*$/u.test(key))
    || new Set(value).size !== value.length) {
    throw new Error('desktop product: invalid required services')
  }
  return value.map((key: string) => key)
}

/** Refuse product readiness when a required Host service is absent.
 * @param ctx - Running Host's service reader.
 * @param required - Exact requirements from the signed product descriptor.
 */
export function assertDesktopRequiredServices(ctx: { get(key: string): unknown }, required: readonly string[]): void {
  const missing = required.filter(key => ctx.get(key) === undefined)
  if (missing.length > 0) throw new Error(`desktop product: required services unavailable: ${missing.join(', ')}`)
}
