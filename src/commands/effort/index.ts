import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'effort',
  description: '设置模型使用的工作量级别',
  argumentHint: '[low|medium|high|xhigh|max|auto]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./effort.js'),
} satisfies Command
