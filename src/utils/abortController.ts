import { setMaxListeners } from 'events'

/** 标准操作的默认最大监听器数量 */
const DEFAULT_MAX_LISTENERS = 50

/** 创建一个设置了适当事件监听器限制的 AbortController。
这可以防止在多个监听器附加到 abort 信号时出现 MaxListenersExceededWarning 警告。

@param maxListeners - 监听器的最大数量（默认值：50）
@returns 配置了监听器限制的 AbortController */
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,
): AbortController {
  const controller = new AbortController()
  setMaxListeners(maxListeners, controller.signal)
  return controller
}

/** 将中止信号从父控制器传播到弱引用的子控制器。
父控制器和子控制器都是弱持有的——任何方向都不会创建可能阻止垃圾回收的强引用。
模块作用域函数避免了每次调用时的闭包分配。 */
function propagateAbort(
  this: WeakRef<AbortController>,
  weakChild: WeakRef<AbortController>,
): void {
  const parent = this.deref()
  weakChild.deref()?.abort(parent?.signal.reason)
}

/** 从弱引用的父信号中移除一个中止处理器。
父信号和处理器都是弱持有的——如果任一已被垃圾回收或父信号已中止（{once: true}），则此操作无效。
模块作用域函数避免了每次调用时的闭包分配。 */
function removeAbortHandler(
  this: WeakRef<AbortController>,
  weakHandler: WeakRef<(...args: unknown[]) => void>,
): void {
  const parent = this.deref()
  const handler = weakHandler.deref()
  if (parent && handler) {
    parent.signal.removeEventListener('abort', handler)
  }
}

/** 创建一个子 AbortController，当父控制器中止时，它也会中止。
中止子控制器不会影响父控制器。

内存安全：使用 WeakRef，因此父控制器不会保留被遗弃的子控制器。
如果子控制器在没有被中止的情况下被丢弃，它仍然可以被垃圾回收。
当子控制器被中止时，父监听器会被移除，以防止累积无效的处理器。

@param parent - 父 AbortController
@param maxListeners - 监听器的最大数量（默认值：50）
@returns 子 AbortController */
export function createChildAbortController(
  parent: AbortController,
  maxListeners?: number,
): AbortController {
  const child = createAbortController(maxListeners)

  // 快速路径：父控制器已中止，无需设置监听器
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
    return child
  }

  // WeakRef 防止父控制器保留一个被遗弃的子控制器。如果所
  // 有对子控制器的强引用在没有中止它的情况下被丢弃，子控制器仍然
  // 可以被垃圾回收——父控制器只持有一个无效的 WeakRef。
  const weakChild = new WeakRef(child)
  const weakParent = new WeakRef(parent)
  const handler = propagateAbort.bind(weakParent, weakChild)

  parent.signal.addEventListener('abort', handler, { once: true })

  // 自动清理：当子控制器被中止时（无论来自何种来源），移除父监听器。父
  // 控制器和处理器都是弱持有的——如果任一已被垃圾回收或父控制器
  // 已中止（{once: true}），清理操作是无害且无效的。
  child.signal.addEventListener(
    'abort',
    removeAbortHandler.bind(weakParent, new WeakRef(handler)),
    { once: true },
  )

  return child
}
