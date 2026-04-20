import { describe, test, expect } from 'bun:test'

describe('/daemon 命令', () => {
  test('index 导出一个有效的 Command', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.name).toBe('daemon')
    expect(cmd.type).toBe('local-jsx')
    expect(typeof cmd.load).toBe('function')
    expect(cmd.description).toContain('daemon')
  })

  test('daemon 模块导出 call 函数', async () => {
    const mod = await import('../daemon.js')
    expect(typeof mod.call).toBe('function')
  })

  test('argumentHint 列出子命令', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.argumentHint).toContain('status')
    expect(cmd.argumentHint).toContain('bg')
  })
})
