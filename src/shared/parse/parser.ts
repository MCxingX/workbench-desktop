import { ACTION_WORDS, CATEGORY_RULES, COMPLETION_WORDS, CONFIRM_WORDS, IMPERATIVE_WORDS, PAST_WORDS, RULE_WORDS, SELF_FUTURE_WORDS, TIME_HINTS, URGENT_WORDS } from './dict'

export interface Entity {
  kind: 'code' | 'doc' | 'ip' | 'host'
  value: string
}

export interface Candidate {
  text: string
  score: number
  confidence: 'high' | 'low'
  entity: string | null
  timeHint: string | null
  kind: 'self' | 'assigned'
  category: string | null
}

export interface ReceiptCandidate {
  text: string
  entity: string | null
}

export interface KnowledgeCandidate {
  title: string
  conclusion: string
  scope: string | null
}

export interface ParseResult {
  todos: Candidate[]
  receipts: ReceiptCandidate[]
  knowledge: KnowledgeCandidate[]
  dropped: number
}

const RE_QUOTED = /^\s*>+\s?/
const RE_SYSTEM = /(撤回了一条消息|加入了群聊|拍了拍|\[图片\]|\[视频\]|\[语音\]|\[文件\]|\[动画表情\])/
const RE_TIMESTAMP = /^\s*(\[\d{1,2}:\d{2}(:\d{2})?\]|\d{1,2}:\d{2}(:\d{2})?|(昨天|今天)\s*\d{1,2}:\d{2})\s*/
const RE_EMOJI_TAG = /\[(OK|ok|抱拳|握手|微笑|强|弱|合十|玫瑰|旺柴|捂脸|破涕为笑)\]/g
const RE_PURE_NUM = /^\s*[\d.、)）一二三四五六七八九十]+\s*$/
const RE_PUNCT_ONLY = /^\s*[，。、！？…~\-—_\s]+\s*$/

const RE_CODE = /\b[A-Z]{2,4}\d{2,4}[-–][A-Z]{2,4}[-–]\d{1,4}\b/g
const RE_SUB = /<([A-Z]{2,4}\d{2,4}[-–][A-Z]{2,4}[-–]\d{1,4})>/g
const RE_DOC = /\b[A-Z]{2,4}[-–]\d{4,8}[-–]{1,2}\d{2,6}\b/g
const RE_IP = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/g
const RE_HOST = /\b[a-z0-9][a-z0-9-]{2,30}\.(?:com|cn|net|local|internal)\b/g

/** 清洗：去引用/系统消息/时间戳/表情标签，丢弃纯数字与纯标点 */
export function cleanLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(RE_QUOTED, '')
        .replace(RE_TIMESTAMP, '')
        .replace(RE_EMOJI_TAG, '')
        .trim()
    )
    .filter((l) => l.length > 0)
    .filter((l) => !RE_SYSTEM.test(l))
    .filter((l) => !RE_PURE_NUM.test(l) && !RE_PUNCT_ONLY.test(l))
}

export function extractEntities(text: string): Entity[] {
  const out: Entity[] = []
  for (const m of text.matchAll(RE_CODE)) out.push({ kind: 'code', value: m[0] })
  for (const m of text.matchAll(RE_SUB)) out.push({ kind: 'code', value: m[1] })
  for (const m of text.matchAll(RE_DOC)) out.push({ kind: 'doc', value: m[0] })
  for (const m of text.matchAll(RE_IP)) out.push({ kind: 'ip', value: m[0] })
  for (const m of text.matchAll(RE_HOST)) out.push({ kind: 'host', value: m[0] })
  // 去重
  const seen = new Set<string>()
  return out.filter((e) => (seen.has(e.value) ? false : (seen.add(e.value), true)))
}

/** 先把实体原文遮掉，再抽时间（否则单号里的 202611 会被误当日期） */
export function maskEntities(text: string): string {
  return text
    .replace(RE_CODE, ' ')
    .replace(RE_SUB, ' ')
    .replace(RE_DOC, ' ')
    .replace(RE_IP, ' ')
    .replace(RE_HOST, ' ')
}

export function findAction(text: string): string | null {
  let found: string | null = null
  for (const w of ACTION_WORDS) {
    if (text.includes(w)) found = w
  }
  // 取最后一个动作（"下午导再解禁" → 解禁）
  return found
}

export function findTime(text: string): { label: string; minutes: number } | null {
  for (const t of TIME_HINTS) {
    if (text.includes(t.word)) return { label: t.label, minutes: t.minutes }
  }
  const hm = /(\d{1,2})[:：](\d{2})/.exec(text)
  if (hm) return { label: `${hm[1].padStart(2, '0')}:${hm[2]}`, minutes: Number(hm[1]) * 60 + Number(hm[2]) }
  return null
}

export function classifyCategory(text: string): string | null {
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((w) => text.includes(w))) return rule.category
  }
  return null
}

export function isCompletion(text: string): boolean {
  const t = text.replace(/[。！!.~]/g, '').trim()
  return COMPLETION_WORDS.some((w) => t === w || t.endsWith(w))
}

export function isConfirmOnly(text: string): boolean {
  const t = text.replace(/[。！!.~，,\s]/g, '').trim()
  return CONFIRM_WORDS.some((w) => t === w)
}

export function isFrequencyish(text: string): boolean {
  return /\d|可能|大概|左右|星期|每天|每周|一次|一个月|一年|不多|很多/.test(text)
}

export function isRuleTone(text: string): boolean {
  return RULE_WORDS.some((w) => text.includes(w))
}

export function isQuestion(text: string): boolean {
  return /[？?]\s*$/.test(text) || /(吗|呢|是不是|要不要|有没有|多吗)\s*$/.test(text)
}

export function isUrgent(text: string): boolean {
  return URGENT_WORDS.some((w) => text.includes(w))
}

/** 规则语气优先于动作词：那是"口径"，不是待办 */
export function scoreBlock(text: string, opts: { hasEntity: boolean; time: { label: string } | null }): number {
  const action = findAction(text)
  if (!action) return 0
  let s = 3
  if (opts.hasEntity) s += 2
  if (opts.time) s += 2
  if (IMPERATIVE_WORDS.some((w) => text.includes(w))) s += 1.5
  if (SELF_FUTURE_WORDS.some((w) => text.includes(w))) s += 1
  if (isQuestion(text) && !opts.time) s -= 2
  if (PAST_WORDS.some((w) => w === '了' ? /了/.test(text) && !opts.time : text.includes(w))) s -= 1.5
  return s
}

interface Block {
  text: string
  entities: Entity[]
}

/** 回合合并：碎片短句并入意图块，确认词只标记不前推 */
export function mergeBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let pending: string[] = []
  let contextEntities: Entity[] = []

  const flush = () => {
    if (pending.length === 0) return
    const text = pending.join(' ')
    const own = extractEntities(text)
    const entities = [...contextEntities, ...own]
    blocks.push({ text, entities })
    if (own.length > 0) contextEntities = own
    pending = []
  }

  for (const line of lines) {
    // 问句/确认/完成态各自独立成块，避免把回执粘进下一句
    const ownBlock = isCompletion(line) || isConfirmOnly(line) || /[？?]\s*$/.test(line) || /(吗|呢)\s*$/.test(line)
    const entitiesInLine = extractEntities(line)
    const isEntityOnly = entitiesInLine.some((e) => line.trim() === e.value) || (entitiesInLine.length > 0 && line.replace(/[^\x00-\x7F]/g, '').trim().length <= 0)

    if (isEntityOnly) {
      flush()
      contextEntities = entitiesInLine
      blocks.push({ text: line, entities: entitiesInLine })
      continue
    }

    if (ownBlock) {
      flush()
      blocks.push({ text: line, entities: [...contextEntities, ...entitiesInLine] })
      continue
    }

    pending.push(line)
    if (/[。！!!]$/.test(line) || line.length >= 15) flush()
  }
  flush()
  return blocks
}

/** 主解析：聊天文本 → 三池 */
export function parseChat(raw: string): ParseResult {
  const blocks = mergeBlocks(cleanLines(raw))
  const todos: Candidate[] = []
  const receipts: ReceiptCandidate[] = []
  const knowledge: KnowledgeCandidate[] = []

  let pendingQuestion: string | null = null
  let pendingScope = false

  for (const block of blocks) {
    const text = block.text
    const entities = block.entities
    const entity = entities[0]?.value ?? null
    const masked = maskEntities(text)

    // 实体独占行：切换上下文，不产出条目
    if (masked.replace(/[\s<>]/g, '').length === 0) continue

    // 确认/回执
    if (isConfirmOnly(masked)) {
      if (pendingScope && knowledge.length > 0) {
        knowledge[knowledge.length - 1].scope = '全部'
        pendingScope = false
      } else if (pendingQuestion) {
        pendingQuestion = null
      }
      continue
    }

    if (isCompletion(masked)) {
      receipts.push({ text: text.trim(), entity })
      continue
    }

    // 范围追问（"全部单据都是？"）→ 等下一句确认，用来补口径的适用范围
    if (isQuestion(masked) && /全部|所有|都/.test(masked) && !findAction(masked)) {
      pendingScope = true
      continue
    }

    // 规则/口径
    if (isRuleTone(masked)) {
      knowledge.push({
        title: masked.replace(/[？?]/g, '').slice(0, 18).trim(),
        conclusion: masked.trim(),
        scope: /全部|所有/.test(masked) ? '全部' : null
      })
      continue
    }

    // 问句且无动作 → 挂着，等下一句数据回答
    if (isQuestion(masked) && !findAction(masked)) {
      pendingQuestion = masked.replace(/[？?]/g, '').trim()
      continue
    }

    const action = findAction(masked)
    const time = findTime(masked)

    // 无动作陈述：只有带频率/数量时才作为问句的答案落成口径，否则丢弃
    if (!action) {
      if (isFrequencyish(masked)) {
        knowledge.push({
          title: pendingQuestion ?? masked.slice(0, 18).trim(),
          conclusion: masked.trim(),
          scope: null
        })
        pendingQuestion = null
      }
      continue
    }

    // 按分句拆：一句里可能有两个动作
    const clauses = masked.split(/[？?。！!；;]/).map((c) => c.trim()).filter(Boolean)
    let emitted = 0
    for (const clause of clauses) {
      const act = findAction(clause)
      if (!act) continue
      const t = findTime(clause)
      const s = scoreBlock(clause, { hasEntity: entities.length > 0, time: t })
      if (s < 1) continue
      todos.push({
        text: buildTodoText(clause, entity),
        score: Math.round(s * 10) / 10,
        confidence: s >= 3 ? 'high' : 'low',
        entity,
        timeHint: t?.label ?? null,
        kind: IMPERATIVE_WORDS.some((w) => clause.includes(w)) ? 'assigned' : 'self',
        category: classifyCategory(clause)
      })
      emitted++
    }
    if (emitted > 0 && time) pendingQuestion = null
  }

  const dropped = blocks.length - todos.length - receipts.length - knowledge.length
  return { todos, receipts, knowledge, dropped: Math.max(0, dropped) }
}

function buildTodoText(clause: string, entity: string | null): string {
  let t = clause
    .replace(/^(那我|那我等下|我|等下|你|麻烦你|记得)\s*/, '')
    .replace(/(咯|啊|吧|哦|呀)/g, '')
    .trim()
  if (entity && !t.includes(entity)) t = `${t}（${entity}）`
  return t
}
