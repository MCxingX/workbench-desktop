import type { BaseShift, ShiftProfile } from './model'
import { parseHM } from './time'

/**
 * 分享链接编解码（对照 docs/09 URL 参数规范）
 * 人类可读参数：v 版本 / n 名称 / s 上班 / e 下班 / l 午休 / wd 周掩码(7 位 0-1) / nx 两周交替
 * 复杂结构（月规则/节假日/例外）整体放进 p（base64url JSON），保证不丢信息。
 */

export interface SharePayload {
  v: 1
  n: string
  s: string
  e: string
  l: string
  wd: string
  nx: string
  p?: string
}

// 注意：这个文件同时跑在主进程和渲染进程，渲染进程没有 Buffer，
// 所以 base64url 必须用 TextEncoder + 手写映射，不能依赖 Node API。
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined
    out += B64URL[b0 >> 2]
    out += B64URL[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 === undefined) break
    out += B64URL[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 === undefined) break
    out += B64URL[b2 & 63]
  }
  return out
}

function b64urlDecode(s: string): string {
  const clean = s.replace(/=+$/, '')
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of clean) {
    const v = B64URL.indexOf(ch)
    if (v < 0) continue
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return new TextDecoder().decode(new Uint8Array(out))
}

export function encodeShare(p: ShiftProfile): string {
  const extra = {
    lunch: p.base.lunch,
    weekCycle: p.weekCycle,
    monthOverrides: p.monthOverrides,
    holidays: p.holidays,
    makeups: p.makeups,
    useHolidays: p.useHolidays,
    dayFlex: p.dayFlex,
    overrides: p.overrides
  }
  const params = new URLSearchParams({
    v: '1',
    n: p.name,
    s: p.base.start,
    e: p.base.end,
    l: p.base.lunch ? `${p.base.lunch.start}-${p.base.lunch.end}` : '',
    wd: p.mask.map((b) => (b ? '1' : '0')).join(''),
    nx: p.weekCycle.mode,
    p: b64urlEncode(JSON.stringify(extra))
  })
  return params.toString()
}

function parseLunch(v: string | null): BaseShift['lunch'] {
  if (!v) return null
  const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(v)
  if (!m) return null
  try {
    parseHM(m[1])
    parseHM(m[2])
    return { start: m[1].padStart(5, '0'), end: m[2].padStart(5, '0') }
  } catch {
    return null
  }
}

export function decodeShare(query: string): ShiftProfile | null {
  const q = query.startsWith('?') ? query.slice(1) : query
  const params = new URLSearchParams(q)
  if (params.get('v') !== '1') {
    // 兼容只给 s/e/l 的第三方链接
    const s = params.get('s')
    const e = params.get('e')
    if (!s || !e) return null
    try {
      parseHM(s)
      parseHM(e)
    } catch {
      return null
    }
    return {
      id: 'imported',
      name: params.get('n') || '导入的班表',
      base: { start: s, end: e, lunch: parseLunch(params.get('l')) },
      mask: [true, true, true, true, true, false, false],
      useHolidays: true,
      weekCycle: { mode: 'none', anchorMonday: '2026-01-05', anchorVariant: 'primary', primary: null, secondary: null },
      monthOverrides: [],
      holidays: [],
      makeups: [],
      overrides: [],
      dayFlex: { enabled: false, flexMinutes: 0 }
    }
  }

  const raw = params.get('p')
  let extra: Record<string, unknown> = {}
  if (raw) {
    try {
      extra = JSON.parse(b64urlDecode(raw)) as Record<string, unknown>
    } catch {
      extra = {}
    }
  }

  const wd = params.get('wd') ?? '1111100'
  const mask = wd.split('').slice(0, 7).map((c) => c === '1')
  while (mask.length < 7) mask.push(false)

  const s = params.get('s')
  const e = params.get('e')
  if (!s || !e) return null
  try {
    parseHM(s)
    parseHM(e)
  } catch {
    return null
  }

  return {
    id: params.get('id') || 'shared',
    name: params.get('n') || '分享的班表',
    base: { start: s, end: e, lunch: parseLunch(params.get('l')) },
    mask,
    useHolidays: (extra.useHolidays as boolean) ?? true,
    weekCycle:
      ((extra.weekCycle as ShiftProfile['weekCycle']) ?? null) ??
      { mode: 'none', anchorMonday: '2026-01-05', anchorVariant: 'primary', primary: null, secondary: null },
    monthOverrides: (extra.monthOverrides as ShiftProfile['monthOverrides']) ?? [],
    holidays: (extra.holidays as ShiftProfile['holidays']) ?? [],
    makeups: (extra.makeups as ShiftProfile['makeups']) ?? [],
    overrides: (extra.overrides as ShiftProfile['overrides']) ?? [],
    dayFlex: (extra.dayFlex as ShiftProfile['dayFlex']) ?? { enabled: false, flexMinutes: 0 }
  }
}
