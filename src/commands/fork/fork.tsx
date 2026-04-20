import { feature } from 'bun:bundle'
import React from 'react'
import { AgentTool } from '@claude-code-best/builtin-tools/tools/AgentTool/AgentTool.js'
import { isInForkChild } from '@claude-code-best/builtin-tools/tools/AgentTool/forkSubagent.js'
import { logForDebugging } from '../../utils/debug.js'
import type { LocalJSXCommandOnDone, LocalJSXCommandContext } from '../../types/command.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  // 检查功能开关
  if (!feature('FORK_SUBAGENT')) {
    onDone('分叉子代理功能未启用。请设置 FEATURE_FORK_SUBAGENT=1 以启用。', { display: 'system' })
    return null
  }

  // 递归分叉防护
  if (isInForkChild(context.messages)) {
    onDone('在已分叉的工作线程内无法再次分叉。请直接使用你的工具完成任务。', { display: 'system' })
    return null
  }

  const directive = args.trim()
  if (!directive) {
    onDone('用法：/fork <指令>\n示例：/fork 修复 validate.ts 中的空值检查', { display: 'system' })
    return null
  }

  // 查找最后一条助理消息作为分叉起点
  const lastAssistantMessage = [...context.messages].reverse().find(
    m => m.type === 'assistant'
  ) as any // 使用类型断言以避免复杂的类型导入

  if (!lastAssistantMessage) {
    onDone('无法分叉：对话历史中没有助理响应。', { display: 'system' })
    return null
  }

  try {
    // 复用 AgentTool 逻辑处理分叉路径
    // 。省略 subagent_type 将触发隐式分叉。
    const input = {
      prompt: directive,
      run_in_background: true, // fork 始终异步运行
      description: `Fork: ${directive.slice(0, 30)}${directive.length > 30 ? '...' : ''}`,
    }

    // 使用正确的参数调用 AgentTool：-
    // input：代理参数（无 subagent_type => 分叉路径）-
    // toolUseContext：当前上下文（ToolUseCon
    // text）- canUseTool：来自上下文的权限检查函数
    // - assistantMessage：作为分叉起点的最后一条助理消息
    AgentTool.call(
      input,
      context,
      context.canUseTool!,
      lastAssistantMessage
    ).catch(error => {
      logForDebugging(`分叉子代理异步错误：${error}`, { level: 'error' })
    })

    // 通知用户分叉已启动
    onDone(`分叉子代理已启动，指令为："${directive}"`, { display: 'system' })
    return null
  } catch (error) {
    // 仅捕获同步设置错误
    logForDebugging(`Fork 命令设置错误：${error}`, { level: 'error' })
    onDone(`分叉失败：${error instanceof Error ? error.message : String(error)}`, { display: 'system' })
    return null
  }
}
