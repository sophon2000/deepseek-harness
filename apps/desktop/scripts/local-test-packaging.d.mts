/** Select an explicit isolated local product without release configuration.
 * @param environment Parent build environment.
 * @returns Fixed local test packaging environment.
 */
export function localTestPackageEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv
/** Validate the explicit subprocess selection.
 * @param environment Build subprocess environment.
 * @param platform Target OS.
 * @param unsigned Requested signing mode.
 * @returns Whether local test mode is selected.
 */
export function isLocalTestPackaging(environment: NodeJS.ProcessEnv, platform: string, unsigned: boolean): boolean
