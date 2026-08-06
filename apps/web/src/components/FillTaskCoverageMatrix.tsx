import type { MessageFillState } from "../api/fill-tasks.ts";
import {
  COVERAGE_COLUMNS,
  COVERAGE_STATE_LABELS,
  COVERAGE_STATE_ORDER,
  summarizeCoverage,
} from "../fill-task-coverage-state.ts";

interface FillTaskCoverageMatrixProps {
  /** 全部消息的四态分类（source_id 升序），来自 GET .../fill-tasks/coverage。 */
  readonly states: readonly { readonly sourceId: number; readonly state: MessageFillState }[];
}

/**
 * 任务覆盖矩阵（ticket 17）：50×N 网格，每消息一个单元格，颜色区分四态；
 * hover 显示消息编号与状态名。任务运行中随轮询实时推进。
 */
export function FillTaskCoverageMatrix({ states }: FillTaskCoverageMatrixProps) {
  const counts = summarizeCoverage(states);
  return (
    <div className="fill-task-coverage">
      <header className="fill-task-coverage-heading">
        <div>
          <strong>任务覆盖</strong>
          <p>
            {states.length} 条消息 · 悬停单元格查看消息编号
            {counts.total === 0 ? " · 该空间还没有消息" : ""}
          </p>
        </div>
      </header>
      <div className="coverage-legend">
        {COVERAGE_STATE_ORDER.map((state) => (
          <span className="coverage-legend-item" key={state}>
            <i className={`coverage-swatch coverage-${state}`} aria-hidden="true" />
            <span>
              {COVERAGE_STATE_LABELS[state]} <b>{counts[state]}</b>
            </span>
          </span>
        ))}
      </div>
      <div
        className="coverage-matrix"
        role="img"
        aria-label="消息填表状态矩阵"
        style={{ gridTemplateColumns: `repeat(${COVERAGE_COLUMNS}, minmax(6px, 1fr))` }}
      >
        {states.map(({ sourceId, state }) => (
          <span
            className={`coverage-cell coverage-${state}`}
            key={sourceId}
            aria-label={`消息 #${sourceId}：${COVERAGE_STATE_LABELS[state]}`}
          >
            <span className="coverage-tooltip">
              <strong>消息 #{sourceId}</strong>
              <em>{COVERAGE_STATE_LABELS[state]}</em>
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
