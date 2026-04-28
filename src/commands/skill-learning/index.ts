import type { Command } from '../../commands.js'
import { isSkillLearningEnabled } from '../../services/skillLearning/featureCheck.js'

const skillLearning = {
  type: 'local-jsx',
  name: 'skill-learning',
  description: '技能学习管理（观察、分析、改进）',
  argumentHint:
    '[start|stop|about|status|ingest|evolve|export|import|prune|promote|projects]',
  isEnabled: () => isSkillLearningEnabled(),
  isHidden: false,
  load: () => import('./skillPanel.js'),
} satisfies Command

export default skillLearning
