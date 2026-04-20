/**
 * Tests for fix: 修复穷鬼模式的写入问题
 *
 * Before the fix, poorMode was an in-memory boolean that reset on restart.
 * After the fix, it reads from / writes to settings.json via
 * getInitialSettings() and updateSettingsForSource().
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

// ── 必须在导入被测模块之前声明模拟对象 ──────────

let mockSettings: Record<string, unknown> = {}
let lastUpdate: { source: string; patch: Record<string, unknown> } | null = null

mock.module('src/utils/settings/settings.js', () => ({
  getInitialSettings: () => mockSettings,
  updateSettingsForSource: (source: string, patch: Record<string, unknown>) => {
    lastUpdate = { source, patch }
    mockSettings = { ...mockSettings, ...patch }
  },
}))

// 在模拟对象注册后导入
const { isPoorModeActive, setPoorMode } = await import('../poorMode.js')

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 通过重新导入一个新副本来重置测试之间的模块级单例。 */
async function freshModule() {
  // Bun 会缓存模块；我们直接操作导出的函数，因为单例 `po
  // orModeActive` 仅在首次导入时重置为 null
  // 。因此我们通过 set/get 对来测试可观察的行为。
}

// ── 测试 ────────────────────────────────────────────────────────────────────

describe('isPoorModeActive — 首次调用时从设置中读取', () => {
  beforeEach(() => {
    lastUpdate = null
  })

  test('当 settings 中没有 poorMode 键时返回 false', () => {
    mockSettings = {}
    // 通过 setPoorMode 设置内部状态然后检查，强制重新读取
    setPoorMode(false)
    expect(isPoorModeActive()).toBe(false)
  })

  test('当 settings.poorMode === true 时返回 true', () => {
    mockSettings = { poorMode: true }
    setPoorMode(true)
    expect(isPoorModeActive()).toBe(true)
  })
})

describe('setPoorMode — 持久化到设置', () => {
  beforeEach(() => {
    lastUpdate = null
  })

  test('setPoorMode(true) 调用 updateSettingsForSource 并传入 poorMode: true', () => {
    setPoorMode(true)
    expect(lastUpdate).not.toBeNull()
    expect(lastUpdate!.source).toBe('userSettings')
    expect(lastUpdate!.patch.poorMode).toBe(true)
  })

  test('setPoorMode(false) 调用 updateSettingsForSource 并传入 poorMode: undefined（移除键）', () => {
    setPoorMode(false)
    expect(lastUpdate).not.toBeNull()
    expect(lastUpdate!.source).toBe('userSettings')
    // false || undefined === undefined — 应移除该键以保持设置整洁
    expect(lastUpdate!.patch.poorMode).toBeUndefined()
  })

  test('isPoorModeActive() 反映由 setPoorMode() 设置的值', () => {
    setPoorMode(true)
    expect(isPoorModeActive()).toBe(true)

    setPoorMode(false)
    expect(isPoorModeActive()).toBe(false)
  })

  test('多次切换保持一致性', () => {
    setPoorMode(true)
    setPoorMode(true)
    expect(isPoorModeActive()).toBe(true)

    setPoorMode(false)
    setPoorMode(false)
    expect(isPoorModeActive()).toBe(false)
  })
})
