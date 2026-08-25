import type {
  AnalyticsAttentionItem,
  AnalyticsUserStat,
} from '@/features/analytics/api/generation-analytics'
import { formatDecimal, formatDuration, formatNumber, formatRate } from './analytics-snapshot.utils'

/**
 * 渲染用户统计表格。
 *
 * @param props - 用户统计表格属性。
 * @param props.rows - 用户统计行。
 * @returns 用户统计表。
 */
export function UserStatsTable({ rows }: { rows: AnalyticsUserStat[] }) {
  return (
    <div className="analytics-detail-pane analytics-detail-pane--users">
      <div className="analytics-section-heading">
        <h2>用户统计</h2>
      </div>
      {rows.length === 0 ? (
        <p className="analytics-empty-text">当前筛选条件下暂无用户统计。</p>
      ) : (
        <div className="analytics-table-scroll">
          <table className="analytics-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>项目</th>
                <th>最终生成</th>
                <th>平均生成次数</th>
                <th>生成总时长</th>
                <th>平均耗时</th>
                <th>首轮成功</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.user}</td>
                  <td>{formatNumber(row.projects)}</td>
                  <td>{formatNumber(row.completed)}</td>
                  <td>{formatDecimal(row.avgRetry)}</td>
                  <td>{formatDuration(row.totalGeneratedDurationSeconds)}</td>
                  <td>{formatDuration(row.avgDurationSeconds)}</td>
                  <td>{formatRate(row.firstPassRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * 渲染需关注项目表格。
 *
 * @param props - 需关注项目属性。
 * @param props.rows - 项目关注行。
 * @returns 需关注项目表。
 */
export function AttentionTable({ rows }: { rows: AnalyticsAttentionItem[] }) {
  return (
    <div className="analytics-detail-pane analytics-detail-pane--attention">
      <div className="analytics-section-heading">
        <h2>需关注项目</h2>
      </div>
      {rows.length === 0 ? (
        <p className="analytics-empty-text">当前筛选条件下暂无异常项目。</p>
      ) : (
        <div className="analytics-attention-list">
          {rows.map((row) => (
            <article key={row.id} className="analytics-attention-item">
              <div>
                <h3>{row.project}</h3>
                <p>{row.reason}</p>
              </div>
              <dl>
                <div>
                  <dt>负责人</dt>
                  <dd title={row.owner}>{row.owner}</dd>
                </div>
                <div>
                  <dt>平均生成次数</dt>
                  <dd>{formatDecimal(row.avgRetry)}</dd>
                </div>
                <div>
                  <dt>平均耗时</dt>
                  <dd>{formatDuration(row.avgDurationSeconds)}</dd>
                </div>
              </dl>
              <span className="analytics-attention-action">已停用</span>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
