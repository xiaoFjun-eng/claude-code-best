import { isEnvTruthy } from '../utils/envUtils.js'

// 延迟读取，以便在模块加载之后应用的 globalSettings.env 中的 ENABLE_GROWTHBOOK_DEV 生效。
// USER_TYPE 为构建期 define，安全。
export function getGrowthBookClientKey(): string {
  return process.env.USER_TYPE === 'ant'
    ? isEnvTruthy(process.env.ENABLE_GROWTHBOOK_DEV)
      ? 'sdk-yZQvlplybuXjYh6L'
      : 'sdk-xRVcrliHIlrg4og4'
    : 'sdk-zAZezfDKGoZuXXKe'
}
