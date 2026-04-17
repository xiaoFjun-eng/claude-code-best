import type { Command } from '../../commands.js'
import { isBuddyLive } from '../../buddy/useBuddyNotification.js'

const buddy = {
  type: 'local-jsx',
  name: 'buddy',
  description: '孵化一个编程伙伴 · 宠物，关闭',
  argumentHint: '[pet|off]',
  immediate: true,
  get isHidden() {
    return !isBuddyLive()
  },
  load: () => import('./buddy.js'),
} satisfies Command

export default buddy
