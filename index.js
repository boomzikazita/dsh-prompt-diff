/**
 * dsh-prompt-diff — ③ world-state diff 注入（借鉴 codex `world_state` 的 typed section + hash + render_diff）
 *
 * 侦察结论（2026-08-22）：DSH 的 SystemPrompt 服务已有 typed sections 架构
 * （PromptLayer sections/contexts + section()/context() 注册 + scoped layers），
 * 且暴露 `system-prompt/assemble` waterfall——插件可在渲染前改造 assembly。
 * 本插件不重复造注册机制，只做一层 diff 变换：
 *
 *   对 assembly.sections/contexts 中超过 minChars 的大块（如技能目录、资产提示）：
 *     - 首轮：全量注入 + 记 sha256（per-session，落盘跨轮）
 *     - 后续同内容：替换为一行缩略「内容未变 hash:xxxx + 去哪要」——
 *       模型需要时用 skill_search / resource ls / check_assets 主动拉取（与 resource 的 ls 互补）
 *     - 内容变化：全量注入 + 更新 hash
 *
 * 安全设计：
 *   - 永不 diff 核心规则块（persona/harness:identity/instructions——skipNames）
 *   - hash 状态 per-session 落盘；进程重启后首轮全量（不信任旧 hash 之外的上下文）
 *   - 缩略行自带"去哪要"指引，即使压缩后上下文丢失也不失可达性
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

export const name = 'dsh-prompt-diff'
export const inject = []
export const Config = null

function expandHome(p) {
  if (typeof p !== 'string' || p === '') return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

export function apply(ctx, config = {}) {
  const stateFile = expandHome(config.stateFile) || resolve(homedir(), '.dsh', 'prompt-diff', 'state.json')
  const minChars = Number(config.minChars) || 500
  const skipNames = Array.isArray(config.skipNames) && config.skipNames.length
    ? config.skipNames
    : ['persona', 'harness:identity', 'instructions']
  mkdirSync(dirname(stateFile), { recursive: true })

  // per-session 状态：{ [sid]: { [blockName]: { h, ts } } }（内存 + 落盘）
  let state = {}
  try { state = JSON.parse(readFileSync(stateFile, 'utf-8')) ?? {} } catch { state = {} }
  let dirty = false
  function persist() {
    if (!dirty) return
    try { writeFileSync(stateFile, JSON.stringify(state)) } catch { /* 落盘失败不影响注入 */ }
    dirty = false
  }
  const persistTimer = setInterval(persist, 60_000).unref?.()

  function sidOf(context) {
    return context?.scope?.session?.id
      ?? context?.session?.id
      ?? context?.scope?.agent?.session?.id
      ?? 'global'
  }

  ctx.on('system-prompt/assemble', (assembly, context, next) => {
    const sid = sidOf(context)
    const blocks = state[sid] ?? {}
    state[sid] = blocks

    const transform = (entry) => {
      if (!entry || typeof entry.text !== 'string') return entry
      if (entry.text.length < minChars) return entry
      if (skipNames.some((kw) => String(entry.name).includes(kw))) return entry
      if (entry.text.includes('[prompt-diff]')) return entry // 已缩略/已变换，防重复
      const h = sha256(entry.text)
      const prev = blocks[entry.name]
      if (prev && prev.h === h) {
        const stamp = new Date(prev.ts).toISOString().slice(0, 16).replace('T', ' ')
        return {
          ...entry,
          text: `[prompt-diff] 「${entry.name}」内容未变（hash ${h.slice(0, 8)}，首次注入 ${stamp}，共 ${entry.text.length} 字符）。需要时主动拉取：技能目录用 skill_search，记忆资产用 resource，变更记录用 check_assets。`,
        }
      }
      blocks[entry.name] = { h, ts: Date.now() }
      dirty = true
      return entry
    }

    const transformed = {
      ...assembly,
      sections: (assembly.sections ?? []).map(transform),
      contexts: (assembly.contexts ?? []).map(transform),
    }
    return next(transformed)
  })

  ctx.on('dispose', () => {
    if (persistTimer) clearInterval(persistTimer)
    persist()
  })
}
