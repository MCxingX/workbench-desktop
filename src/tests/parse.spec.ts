import { describe, expect, it } from 'vitest'
import { cleanLines, extractEntities, mergeBlocks, parseChat } from '../shared/parse/parser'
import { parseQuickTodo } from '../shared/parse/quick'

const CASE_1 = `RJ2021-QT-25<DQ2020-BIM-02>
1
可以了
那我等下中午禁用咯？下午导再解禁？
下午
我中午导入
行
上班应该就可以
GD2021-GK-02
解了`

const CASE_2 = `最近反审核多吗
多几个单子走完流程搜不到
AP-202611--0122
看到记录了
最近反审核不多，可能2-3个星期，才一条左右
有反审核 让他们先去财务部拿纸质单据
全部单据都是？
是的
[OK]`

describe('清洗', () => {
  it('丢弃纯数字、系统消息、表情标记', () => {
    const lines = cleanLines('1\n[图片]\n你好\n[OK]\n，。')
    expect(lines).toEqual(['你好'])
  })

  it('剥离时间戳前缀与引用符号', () => {
    const lines = cleanLines('> 10:31 明天把周报发我')
    expect(lines[0]).toBe('明天把周报发我')
  })
})

describe('实体抽取', () => {
  it('识别工单编号与尖括号子项', () => {
    const es = extractEntities('RJ2021-QT-25<DQ2020-BIM-02>')
    expect(es.map((e) => e.value)).toContain('RJ2021-QT-25')
    expect(es.map((e) => e.value)).toContain('DQ2020-BIM-02')
  })

  it('识别含双连字符的单号', () => {
    expect(extractEntities('AP-202611--0122')[0].value).toBe('AP-202611--0122')
  })
})

describe('回合合并', () => {
  it('确认词独立成块，不与前后句粘连', () => {
    const blocks = mergeBlocks(['我中午导入', '行', '上班应该就可以'])
    expect(blocks.map((b) => b.text)).toEqual(['我中午导入', '行', '上班应该就可以'])
  })

  it('问句独立成块（便于和下一条数据配对）', () => {
    const blocks = mergeBlocks(['最近反审核多吗', '最近反审核不多，可能2-3个星期'])
    expect(blocks[0].text).toBe('最近反审核多吗')
    expect(blocks[1].text).toContain('2-3个星期')
  })

  it('编号独占一行时切换上下文实体', () => {
    const blocks = mergeBlocks(['GD2021-GK-02', '解了'])
    expect(blocks[0].entities[0].value).toBe('GD2021-GK-02')
    expect(blocks[1].entities[0].value).toBe('GD2021-GK-02')
  })
})

describe('案例一：能抽出待办', () => {
  const r = parseChat(CASE_1)

  it('抽出 3 条待办', () => {
    expect(r.todos).toHaveLength(3)
  })

  it('待办里带编号与时间提示', () => {
    const joined = r.todos.map((t) => `${t.text}|${t.timeHint ?? ''}|${t.entity ?? ''}`).join('\n')
    expect(joined).toContain('RJ2021-QT-25')
    expect(joined).toMatch(/12:00|14:00/)
  })

  it('完成态进回执，不生成待办', () => {
    expect(r.receipts.length).toBeGreaterThanOrEqual(1)
    expect(r.todos.some((t) => t.text.includes('解了'))).toBe(false)
  })

  it('不产出任何口径', () => {
    expect(r.knowledge).toHaveLength(0)
  })
})

describe('案例二：不该产出待办', () => {
  const r = parseChat(CASE_2)

  it('待办 0 条（硬凑就是噪声）', () => {
    expect(r.todos).toHaveLength(0)
  })

  it('抽出 2 条口径', () => {
    expect(r.knowledge).toHaveLength(2)
  })

  it('频率口径内容正确', () => {
    const freq = r.knowledge.find((k) => /反审核/.test(k.title))
    expect(freq).toBeTruthy()
    expect(freq!.conclusion).toContain('2-3个星期')
  })

  it('处理口径带"全部"适用范围', () => {
    const rule = r.knowledge.find((k) => /让他们/.test(k.conclusion))
    expect(rule).toBeTruthy()
    expect(rule!.scope).toBe('全部')
  })

  it('"看到记录了"进回执并带上单号', () => {
    expect(r.receipts).toHaveLength(1)
    expect(r.receipts[0].entity).toBe('AP-202611--0122')
  })
})

describe('单行快速录入', () => {
  it('时间词从句子里拆出来', () => {
    const q = parseQuickTodo('明天下午三点前把周报发给张总')
    expect(q.timeHint).not.toBeNull()
    expect(q.text).not.toContain('明天')
    expect(q.category).toBe('文档')
  })

  it('含"急"才给优先级', () => {
    expect(parseQuickTodo('急：回复客户工单').priority).toBe(2)
    expect(parseQuickTodo('整理月底报表').priority).toBe(0)
  })

  it('没有时间词也能存', () => {
    const q = parseQuickTodo('把巡检记录发给张总')
    expect(q.text).toBe('把巡检记录发给张总')
    expect(q.timeHint).toBeNull()
  })
})
