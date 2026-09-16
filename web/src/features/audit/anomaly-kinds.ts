/** 九种异常给人看的名字、轻重与一句话说明。 */

import type { Anomaly, AnomalyKind } from './audit.api'
import { formatDuration, formatTokens } from './format'

export type AnomalyTone = 'bad' | 'warn' | 'info'

type AnomalyMeta = {
  label: string
  tone: AnomalyTone
  describe: (anomaly: Anomaly) => string
}

const whole = (value: number | null) => (value === null ? '?' : String(Math.round(value)))
const hours = (value: number | null) =>
  value === null ? '?' : value >= 48 ? `${(value / 24).toFixed(1)} 天` : `${value.toFixed(1)} 小时`

export const ANOMALY_META: Record<AnomalyKind, AnomalyMeta> = {
  retry: {
    label: '反复重试',
    tone: 'bad',
    describe: ({ shot, value, threshold }) =>
      `第 ${shot ?? '?'} 镜出了 ${whole(value)} 次，超过 ${whole(threshold)} 次`,
  },
  idle: {
    label: '空转',
    tone: 'bad',
    describe: ({ value }) => `跑过、没出片，${hours(value)}没动静`,
  },
  slow: {
    label: '交付过慢',
    tone: 'warn',
    describe: ({ value, threshold }) =>
      `交付周期 ${formatDuration(value)}，超过范围内的 P90 ${formatDuration(threshold)}`,
  },
  stuck: {
    label: '视频悬挂',
    tone: 'warn',
    describe: ({ value }) => `提交上游 ${hours(value)}还没结果`,
  },
  spend: {
    label: '消耗离群',
    tone: 'warn',
    describe: ({ value, threshold }) =>
      `${value === null ? '?' : formatTokens(value)} token，超过范围内的 P95 ${threshold === null ? '?' : formatTokens(threshold)}`,
  },
  task_stuck: {
    label: '需求单卡住',
    tone: 'warn',
    describe: ({ value }) => `挂了 ${whole(value)} 段对话，一条成片都没有`,
  },
  deleted: {
    label: '已删对话',
    tone: 'info',
    describe: ({ value }) => `属主删掉了，里面有 ${whole(value)} 条成片`,
  },
  no_task: {
    label: '没挂需求单',
    tone: 'info',
    describe: ({ value }) => `出了 ${whole(value)} 条成片，却没归到任何需求单`,
  },
  missing_shot: {
    label: '没带镜号',
    tone: 'info',
    describe: () => '这条视频没带镜号，不计入成功率；调用方接入可能退化',
  },
}

export const ANOMALY_KINDS = Object.keys(ANOMALY_META) as AnomalyKind[]
