import React from 'react'
import { FpsMetricsProvider } from '../context/fpsMetrics.js'
import { StatsProvider, type StatsStore } from '../context/stats.js'
import { type AppState, AppStateProvider } from '../state/AppState.js'
import { onChangeAppState } from '../state/onChangeAppState.js'
import type { FpsMetrics } from '../utils/fpsTracker.js'
import { ThemeProvider } from '@anthropic/ink'

type Props = {
  getFpsMetrics: () => FpsMetrics | undefined
  stats?: StatsStore
  initialState: AppState
  children: React.ReactNode
}

/** 交互式会话的顶层包装器。
为组件树提供 FPS 指标、统计上下文和应用状态。 */
export function App({
  getFpsMetrics,
  stats,
  initialState,
  children,
}: Props): React.ReactNode {
  return (
    <FpsMetricsProvider getFpsMetrics={getFpsMetrics}>
      <StatsProvider store={stats}>
        <AppStateProvider
          initialState={initialState}
          onChangeAppState={onChangeAppState}
        >
          {children}
        </AppStateProvider>
      </StatsProvider>
    </FpsMetricsProvider>
  )
}
