/** 词表：全部可在设置里改，代码里不写死业务语义 */

export const ACTION_WORDS = [
  '禁用',
  '解禁',
  '停用',
  '启用',
  '重启',
  '关机',
  '开机',
  '导入',
  '导出',
  '备份',
  '恢复',
  '回滚',
  '发布',
  '上线',
  '下线',
  '部署',
  '加白',
  '开权限',
  '提工单',
  '走流程',
  '归档',
  '清理',
  '迁移',
  '巡检',
  '核对',
  '对账',
  '排查',
  '定位',
  '抓包',
  '看日志',
  '查日志',
  '更新',
  '升级',
  '打补丁',
  '确认',
  '回复',
  '反馈',
  '同步',
  '发给',
  '提交',
  '报备',
  '申请',
  '整理',
  '汇总',
  '编写',
  '对接',
  '联系',
  '跟进',
  '催',
  '提醒',
  '安排',
  '约',
  '拿',
  '给'
]

export const COMPLETION_WORDS = [
  '可以了',
  '好了',
  '解了',
  '处理了',
  '完成了',
  '搞定',
  '看到记录了',
  '已解禁',
  '已导入',
  '已发',
  '发你了',
  '导完了',
  '弄完了'
]

/** 纯确认/应答：只表示"看到了"，不产生任何条目 */
export const CONFIRM_WORDS = ['行', '好的', '好', '收到', '嗯', '是的', '对', 'OK', '可以', '没问题']

export const RULE_WORDS = ['让他们', '以后都', '以后', '默认', '一律', '全部', '都要', '统一', '规定', '流程是']

export const IMPERATIVE_WORDS = ['你去', '你把', '你确认', '记得', '麻烦', '帮我', '帮我看', '让他们', '你去问']

export const SELF_FUTURE_WORDS = ['我', '等下', '一会儿', '马上', '待会']

export const PAST_WORDS = ['已经', '刚', '了', '发你了', '导完了']

export const CATEGORY_RULES: { category: string; words: string[] }[] = [
  { category: '文档', words: ['周报', '日报', '报表', '文档', '汇报', '材料', '总结', '写'] },
  { category: '会议', words: ['开会', '会议', '评审', '对接会', '例会'] },
  { category: '行政', words: ['报销', '请假', '考勤', '签字', '盖章', '申请', '审批'] },
  { category: '开发', words: ['上线', '发布', '部署', '回滚', '打补丁', '升级', '代码', '接口'] },
  { category: '沟通', words: ['回复', '联系', '对接', '反馈', '沟通', '问一下', '告知'] },
  { category: '运维', words: ['巡检', '备份', '重启', '工单', '禁用', '解禁', '导入', '导出', '日志', '服务器', '数据库'] }
]

export const URGENT_WORDS = ['急', '尽快', '马上', '立刻', '今天必须', '优先']

export const TIME_HINTS: { word: string; minutes: number; label: string }[] = [
  { word: '中午', minutes: 12 * 60, label: '12:00' },
  { word: '上午', minutes: 9 * 60, label: '09:00' },
  { word: '下午', minutes: 14 * 60, label: '14:00' },
  { word: '晚上', minutes: 19 * 60, label: '19:00' },
  { word: '上班后', minutes: 9 * 60, label: '上班后' },
  { word: '下班前', minutes: 18 * 60, label: '下班前' },
  { word: '马上', minutes: -1, label: '马上' },
  { word: '等下', minutes: -1, label: '等下' },
  { word: '一会儿', minutes: -1, label: '一会儿' }
]
