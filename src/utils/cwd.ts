import { AsyncLocalStorage } from 'async_hooks'
import { getCwdState, getOriginalCwd } from '../bootstrap/state.js'

const cwdOverrideStorage = new AsyncLocalStorage<string>()

/** 在当前异步上下文中，以覆盖的工作目录运行一个函数。
函数内（及其异步子任务）所有对 pwd()/getCwd() 
的调用都将返回被覆盖的当前工作目录，而非全局目录。
这使得并发代理可以各自看到自己的工作目录，而不会相互影响。 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn)
}

/** 获取当前工作目录 */
export function pwd(): string {
  return cwdOverrideStorage.getStore() ?? getCwdState()
}

/** 获取当前工作目录；如果当前目录不可用，则返回原始工作目录 */
export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return getOriginalCwd()
  }
}
