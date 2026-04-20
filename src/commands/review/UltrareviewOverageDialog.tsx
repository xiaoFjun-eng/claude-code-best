import React, { useCallback, useRef, useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Box, Dialog, Text } from '@anthropic/ink'

type Props = {
  onProceed: (signal: AbortSignal) => Promise<void>
  onCancel: () => void
}

export function UltrareviewOverageDialog({
  onProceed,
  onCancel,
}: Props): React.ReactNode {
  const [isLaunching, setIsLaunching] = useState(false)
  const abortControllerRef = useRef(new AbortController())

  const handleSelect = useCallback(
    (value: string) => {
      if (value === 'proceed') {
        setIsLaunching(true)
        // 如果 onProceed 拒绝（例如 launchRemoteReview
        // 抛出异常），onDone 将永远不会被调用，对话框保持挂载状态——恢复 Se
        // lect 组件，以便用户可以重试或取消，而不是一直盯着“正在启动…”的提示。
        void onProceed(abortControllerRef.current.signal).catch(() =>
          setIsLaunching(false),
        )
      } else {
        onCancel()
      }
    },
    [onProceed, onCancel],
  )

  // 在启动过程中按下 Escape 键会通过 signal 中止正在执行的 onPr
  // oceed，这样调用方可以跳过副作用（confirmOverage、onDon
  // e）——否则，一个“发射后不管”的启动操作会继续运行并计费，尽管用户已经“取消”。
  const handleCancel = useCallback(() => {
    abortControllerRef.current.abort()
    onCancel()
  }, [onCancel])

  const options = [
    { label: '继续执行额外用量计费', value: 'proceed' },
    { label: 'Cancel', value: 'cancel' },
  ]

  return (
    <Dialog
      title="Ultrareview 计费"
      onCancel={handleCancel}
      color="background"
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          您所在组织的免费 ultrareviews 额度已用完。后续的评审将按额外用量（按使用付费）计费。</Text>
        {isLaunching ? (
          <Text color="background">Launching…</Text>
        ) : (
          <Select
            options={options}
            onChange={handleSelect}
            onCancel={handleCancel}
          />
        )}
      </Box>
    </Dialog>
  )
}
