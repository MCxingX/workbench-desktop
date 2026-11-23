import fs from 'node:fs'
import path from 'node:path'

/** 内置模块 id：外部插件只能"引用"内置模块，不能自带可执行代码（M6 边界） */
export const BUILTIN_MODULE_IDS = [
  'countdown',
  'checkin',
  'todos',
  'pasteparse',
  'worklog',
  'knowledge',
  'notes',
  'pomodoro',
  'settings'
] as const

export type BuiltinModuleId = (typeof BUILTIN_MODULE_IDS)[number]

/** 现在只允许这三类权限，其余一律判为越权 */
export const ALLOWED_PERMISSIONS = ['read:settings', 'write:settings', 'read:stats'] as const

export interface PluginManifest {
  id: string
  name: string
  moduleId: string
  version?: string
  permissions?: string[]
  enabled?: boolean
  /** 声明式配置：只能改内置模块的 props，不能注入脚本 */
  props?: Record<string, unknown>
}

export interface PluginLoadResult {
  plugins: PluginManifest[]
  issues: { file: string; message: string }[]
  dir: string
}

function validManifest(raw: unknown): { ok: true; value: PluginManifest } | { ok: false; why: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, why: '不是 JSON 对象' }
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(m.id)) return { ok: false, why: 'id 必须是 2-32 位小写字母/数字/连字符' }
  if (typeof m.name !== 'string' || m.name.trim().length === 0) return { ok: false, why: '缺少 name' }
  if (typeof m.moduleId !== 'string' || !BUILTIN_MODULE_IDS.includes(m.moduleId as BuiltinModuleId)) {
    return { ok: false, why: `moduleId 必须引用内置模块：${BUILTIN_MODULE_IDS.join('/')}` }
  }
  const perms = Array.isArray(m.permissions) ? m.permissions : []
  for (const p of perms) {
    if (typeof p !== 'string' || !ALLOWED_PERMISSIONS.includes(p as (typeof ALLOWED_PERMISSIONS)[number])) {
      return { ok: false, why: `权限 ${String(p)} 不在允许清单（${ALLOWED_PERMISSIONS.join('/')}）` }
    }
  }
  if (m.props !== undefined && (typeof m.props !== 'object' || m.props === null)) {
    return { ok: false, why: 'props 必须是对象' }
  }
  return {
    ok: true,
    value: {
      id: m.id,
      name: m.name.trim(),
      moduleId: m.moduleId,
      version: typeof m.version === 'string' ? m.version : undefined,
      permissions: perms as string[],
      enabled: m.enabled === undefined ? true : Boolean(m.enabled),
      props: (m.props as Record<string, unknown>) ?? {}
    }
  }
}

/** 扫描数据目录下的 plugins/*.json（声明式，无代码执行） */
export function loadPlugins(dataDir: string): PluginLoadResult {
  const dir = path.join(dataDir, 'plugins')
  const issues: PluginLoadResult['issues'] = []
  const plugins: PluginManifest[] = []
  if (!fs.existsSync(dir)) return { plugins, issues, dir }

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const full = path.join(dir, file)
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as unknown
      const res = validManifest(parsed)
      if (res.ok) {
        if (plugins.some((p) => p.id === res.value.id)) {
          issues.push({ file, message: `插件 id 重复：${res.value.id}` })
        } else {
          plugins.push(res.value)
        }
      } else {
        issues.push({ file, message: res.why })
      }
    } catch (err) {
      issues.push({ file, message: `JSON 解析失败：${(err as Error).message}` })
    }
  }
  return { plugins, issues, dir }
}

/** 生成一个可用的示例清单，方便用户照抄 */
export function writeSampleManifest(dataDir: string): string {
  const dir = path.join(dataDir, 'plugins')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'sample-countdown.json')
  const sample: PluginManifest = {
    id: 'sample-countdown',
    name: '倒计时（示例）',
    moduleId: 'countdown',
    version: '1.0.0',
    permissions: ['read:settings'],
    enabled: true,
    props: { big: true }
  }
  fs.writeFileSync(file, JSON.stringify(sample, null, 2), 'utf8')
  return file
}
