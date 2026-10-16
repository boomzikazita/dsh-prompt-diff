/**
 * dsh-prompt-diff — ③ world-state diff 注入（借鉴 codex `world_state` 的 typed section + hash + render_diff）
 *
 * v0.2.1（2026-10-15）：
 *   1. **契约修正（关键）**：cordis waterfall 的 `next` 不接收参数
 *      （`const next = () => (cbs.shift() ?? inner)(...args)`），原 `return next(transformed)`
 *      把变换当参数传入 ⇒ 被整包丢弃：本插件的核心 diff 注入**全程 no-op**
 *      （hash 照写、state.json 照更新，属"假活"）。改为官方契约 `const a = await next(); return 变换(a)`。
 *   2. cost_audit：默认插件目录自动探测（原默认 ~/.dsh/plugins 本机无任何插件源码 ⇒ 恒报
 *      「0 字符 ✅ 预算内」假阴性）；三参数由 required 改可选（描述本就写"可省略"）；
 *      skill 目录缺失/为空时如实报"未计量"，不再假报预算内。
 *
 * v0.2.0（2026-10-14，dsh 0.2 适配 + 收敛）：
 *   1. 删除 `export const Config = null`（Config 不导出才安全，null 会崩设置页）
 *   2. state.json 清理：仅保留最近 keepSessions 个 session id（默认 50，可配）
 *   3. 并入 cost_audit 工具（自 dsh-skill-lazy 迁入，工具名不变）——
 *      token 成本审计与 diff 注入同属「上下文/token 经济」一族
 *   4. assemble 变换不产生插件消息、不新建 source（保留 entry 原 source 维持官方 digest），
 *      故无 V3 source 形态需要改 v4——全文件无 { kind:'plugin', plugin:... } 残留
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
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-prompt-diff'
export const inject = ['tools']

// cost_audit 用：skill 目录根（自 dsh-skill-lazy 迁入的支撑常量）
const SKILLS_DIR = join(homedir(), '.dsh', 'skills')

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
  const keepSessions = Number(config.keepSessions) || 50 // v0.2.0：state.json 只保留最近 N 个 session id
  const skipNames = Array.isArray(config.skipNames) && config.skipNames.length
    ? config.skipNames
    : ['persona', 'harness:identity', 'instructions']
  mkdirSync(dirname(stateFile), { recursive: true })

  // per-session 状态：{ [sid]: { [blockName]: { h, ts } } }（内存 + 落盘）
  let state = {}
  try { state = JSON.parse(readFileSync(stateFile, 'utf-8')) ?? {} } catch { state = {} }
  let dirty = false

  // v0.2.0 state 清理：session id 超过 keepSessions 时，按「块 ts 最大值最近」排序裁掉尾部
  function pruneState() {
    const sids = Object.keys(state)
    if (sids.length <= keepSessions) return
    const lastTs = (sid) => Math.max(0, ...Object.values(state[sid] ?? {}).map((b) => b?.ts ?? 0))
    for (const sid of sids.sort((a, b) => lastTs(b) - lastTs(a)).slice(keepSessions)) {
      delete state[sid]
      dirty = true
    }
  }
  pruneState() // 加载后即清一次，历史积压当场收敛
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

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // v0.2.1 关键修正：cordis waterfall 的 `next` **不接收参数**
    //   （cordis lib/index.js：`const next = () => (cbs.shift() ?? inner)(...args)`）
    // 原实现 `return next(transformed)` 把变换当参数传进去 ⇒ 被整包丢弃，装配结果仍是原文，
    // 于是 hash 照写、state.json 照更新，但"未变只注入缩略行"从未生效（假活）。
    // 官方契约（dsh-time-context / dsh-working-directory 同款）：先 `await next()` 拿下游结果，
    // 再把自己的变换作为**返回值**交回 waterfall。
    const assembly = await next()
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
          text: `[prompt-diff] 「${entry.name}」内容未变（hash ${h.slice(0, 8)}，上次变更 ${stamp}，共 ${entry.text.length} 字符）。需要时主动拉取：技能目录用 skill_search，记忆资产用 resource，变更记录用 check_assets。`,
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
    pruneState() // v0.2.0：每轮组装后裁剪 session 数
    return transformed
  })

  // ---------- cost_audit：token 成本审计（v0.2.0 自 dsh-skill-lazy 迁入，工具名不变） ----------
  // 前馈表条目：插件工具描述总量 > 阈值 → 触发瘦身/折叠决策。
  // 工具给数字（描述字符/token 估算），模型给判断（是否瘦身）。
  ctx.tools.register(defineTool({
    name: 'cost_audit',
    description: 'token 成本审计：统计全部插件工具 description 与 skill 目录的字符/token 开销，对照预算阈值（工具描述默认 1500 tokens、skill 目录默认 800 tokens），超阈值提示瘦身/折叠。插件越建越多时的成本看门狗（控制论前馈：先观测再开药）。',
    parameters: {
      pluginDir: { type: 'string', description: '插件目录（省略则自动探测 ~/dsh-plugins → ~/.dsh/plugins）' },
      toolBudgetTokens: { type: 'number', description: '工具描述 token 预算（默认 1500）' },
      skillBudgetTokens: { type: 'number', description: 'skill 目录 token 预算（默认 800）' },
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input) {
      const HOME = homedir()
      const toolBudget = Number(input?.toolBudgetTokens) || 1500
      const skillBudget = Number(input?.skillBudgetTokens) || 800
      const lines = ['[cost_audit] token 成本审计', '']

      // v0.2.1：默认目录修正——原默认 ~/.dsh/plugins 在本机**没有任何插件源码**
      // （只有一个 dsh-memory/honcho 软链），实测恒报「0 字符 ✅ 预算内」＝假阴性。
      // 现：显式传入优先；否则按候选顺序探测，可探测到的目录全部计入。
      const roots = input?.pluginDir
        ? [String(input.pluginDir).replace(/^~/, HOME)]
        : [join(HOME, 'dsh-plugins'), join(HOME, '.dsh', 'plugins')].filter((p) => existsSync(p))
      if (roots.length === 0) roots.push(join(HOME, '.dsh', 'plugins'))

      // ① 插件工具描述统计
      let toolChars = 0
      const perPlugin = []
      const scanned = []
      for (const pluginDir of roots) {
        let n = 0
        try {
          for (const d of readdirSync(pluginDir, { withFileTypes: true })) {
            if (!d.isDirectory()) continue
            const f = join(pluginDir, d.name, 'index.js')
            if (!existsSync(f)) continue
            const text = readFileSync(f, 'utf8')
            const descs = text.match(/description:\s*'([^']{20,})'/g) || []
            const chars = descs.reduce((s, x) => s + x.length - 16, 0) // 去掉 description: ' 包裹
            toolChars += chars
            perPlugin.push([d.name, chars])
            n += 1
          }
        } catch (e) {
          lines.push(`⚠️ 插件目录读取失败 ${pluginDir}: ${e.message}`)
        }
        scanned.push(`${pluginDir}（${n} 个插件）`)
      }
      const toolTokens = Math.round(toolChars / 4)
      lines.push(`扫描目录: ${scanned.join(' | ')}`)
      lines.push(`① 插件工具描述: ${toolChars} 字符 ≈ ${toolTokens} tokens/轮（预算 ${toolBudget}；口径=description 字符串，不含完整 schema）`)
      for (const [name, chars] of perPlugin.sort((a, b) => b[1] - a[1])) {
        const mark = chars > 700 ? ' ⚠️ 超 700 字符建议瘦身' : ''
        lines.push(`  - ${name}: ${chars} 字符 ≈ ${Math.round(chars / 4)} tokens${mark}`)
      }
      if (toolChars === 0) {
        lines.push('  ⚠️ 未扫到任何插件 → 预算未计量（本机插件源码通常在 ~/dsh-plugins，可显式传 pluginDir）')
      } else if (toolTokens > toolBudget) {
        lines.push(`  ❌ 超预算 ${toolTokens - toolBudget} tokens → 建议：对超长描述（>700 字符）瘦身，细节移 skill 文档`)
      } else {
        lines.push(`  ✅ 预算内（余 ${toolBudget - toolTokens} tokens）`)
      }

      // ② skill 目录统计（v0.2.1：目录缺失/为空时如实报"未计量"，不再假报 ✅）
      let skillChars = 0
      let skillCount = 0
      let skillDirMissing = false
      try {
        if (!existsSync(SKILLS_DIR)) skillDirMissing = true
        else {
          for (const d of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
            if (!d.isDirectory()) continue
            const f = join(SKILLS_DIR, d.name, 'SKILL.md')
            if (!existsSync(f)) continue
            const raw = readFileSync(f, 'utf8')
            const fm = raw.match(/^---\n([\s\S]*?)\n---/)
            if (!fm) continue
            const descM = fm[1].match(/^description:\s*(.+)$/m)
            if (descM) { skillChars += descM[1].trim().length; skillCount += 1 }
          }
        }
      } catch (e) {
        lines.push(`⚠️ skill 目录读取失败: ${e.message}`)
      }
      const skillTokens = Math.round(skillChars / 4)
      lines.push('')
      lines.push(`② skill 目录 ${SKILLS_DIR}: ${skillCount} 个技能，description 合计 ${skillChars} 字符 ≈ ${skillTokens} tokens/轮（预算 ${skillBudget}）`)
      if (skillCount === 0) {
        lines.push(`  ⚠️ ${skillDirMissing ? '目录不存在' : '目录内没有 SKILL.md'} → 预算未计量。现役技能可能装在别处（外部 CLI 目录），用 skill_search 可看实际目录。`)
      } else if (skillTokens > skillBudget) {
        lines.push(`  ❌ 超预算 → 精简 description（第一句 ≤40 字符）或折叠目录`)
      } else {
        lines.push(`  ✅ 预算内`)
      }

      // ③ 结论
      lines.push('')
      lines.push(`合计固定开销: ~${toolTokens + skillTokens} tokens/轮`)
      lines.push('控制论注：工具给数字，模型给判断——超预算项先确认"是否影响好用度"再瘦身；瘦身后观测回归（pHat 不升即为安全）。')
      return lines.join('\n')
    },
  }))

  ctx.on('dispose', () => {
    if (persistTimer) clearInterval(persistTimer)
    persist()
  })
}
