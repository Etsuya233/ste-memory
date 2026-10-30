import { useState } from "react";
import type { FillTaskView } from "../../../features/fill-tasks/fill-task.ts";
import {
  COVERAGE_STATUS_LABELS,
  type CoverageStatus,
  type CoverageViewModel,
} from "../../models/tasks/task-panel-model.ts";
import { Button } from "../../primitives/button.tsx";
import { cn } from "../../primitives/utils.ts";

const coverageClasses: Record<CoverageStatus, string> = {
  processed: "ste:bg-foreground/70",
  running: "ste:bg-foreground/30",
  error: "ste:bg-destructive",
  untracked: "ste:border ste:border-foreground/25 ste:bg-background",
};

type CoverageCount = "processedCount" | "runningCount" | "errorCount" | "untrackedCount";

const coverageLegend: readonly { status: CoverageStatus; count: CoverageCount }[] = [
  { status: "processed", count: "processedCount" },
  { status: "running", count: "runningCount" },
  { status: "error", count: "errorCount" },
  { status: "untracked", count: "untrackedCount" },
];

/** 逐层方格每组楼层数（组下方标注起点楼层，换行时仍能对应楼层号）。 */
const FLOOR_GROUP_SIZE = 10;
/** 楼层数不超过此值时默认展开逐层方格，超过则先看比例条。 */
const DETAIL_AUTO_EXPAND_LIMIT = 60;

export function CoverageBar({
  coverage,
  onSelectRange,
}: {
  coverage: CoverageViewModel;
  /** 点击未计划区间时填入手动填表范围（未提供时不渲染区间按钮） */
  onSelectRange?: (range: { readonly from: number; readonly to: number }) => void;
}) {
  const [detailPreference, setDetailPreference] = useState<boolean | null>(null);
  if (coverage.totalCount === 0) return null;
  const summary = coverageLegend
    .map(({ status, count }) => `${COVERAGE_STATUS_LABELS[status]} ${coverage[count]}`)
    .join("，");
  const detail = detailPreference ?? coverage.totalCount <= DETAIL_AUTO_EXPAND_LIMIT;
  const untrackedRuns = coverage.runs.filter((run) => run.status === "untracked");
  return (
    <div className="ste:flex ste:flex-col ste:gap-2">
      {/* 比例条：区间宽度按楼层数分配，用于总览；逐层位置看下方方格 */}
      <div
        role="img"
        aria-label={`楼层覆盖：${summary}`}
        className="ste:flex ste:h-2.5 ste:w-full ste:overflow-hidden ste:rounded-full ste:bg-muted"
      >
        {coverage.runs.map((run) => (
          <div
            key={`${run.status}-${run.from}-${run.to}`}
            title={`#${run.from}–#${run.to} · ${COVERAGE_STATUS_LABELS[run.status]}`}
            className={cn("ste:h-full", coverageClasses[run.status])}
            style={{ flexGrow: run.to - run.from + 1, flexBasis: 0, minWidth: 2 }}
          />
        ))}
      </div>
      <div className="ste:flex ste:flex-wrap ste:gap-x-3 ste:gap-y-1 ste:text-xs ste:text-muted-foreground">
        {coverageLegend.map(({ status, count }) => (
          <span key={status} className="ste:inline-flex ste:items-center ste:gap-1">
            <span
              aria-hidden="true"
              className={cn("ste:size-2 ste:rounded-full", coverageClasses[status])}
            />
            {COVERAGE_STATUS_LABELS[status]} {coverage[count]}
          </span>
        ))}
      </div>
      {untrackedRuns.length > 0 && onSelectRange && (
        <div className="ste:flex ste:max-h-24 ste:flex-wrap ste:items-center ste:gap-1 ste:overflow-y-auto ste:p-0.5">
          <span className="ste:mr-1 ste:text-xs ste:text-muted-foreground">
            {COVERAGE_STATUS_LABELS.untracked}
          </span>
          {untrackedRuns.map((run) => (
            <Button
              key={`${run.from}-${run.to}`}
              variant="outline"
              size="xs"
              className="ste:tabular-nums"
              aria-label={`填入楼层 ${run.from === run.to ? run.from : `${run.from}–${run.to}`}`}
              onClick={() => onSelectRange({ from: run.from, to: run.to })}
            >
              {run.from === run.to ? `#${run.from}` : `#${run.from}–#${run.to}`}
            </Button>
          ))}
        </div>
      )}
      <div className="ste:flex ste:flex-col ste:gap-2">
        <Button
          variant="ghost"
          size="xs"
          className="ste:self-start"
          aria-expanded={detail}
          onClick={() => setDetailPreference(!detail)}
        >
          {detail ? "收起逐层" : "展开逐层"}
        </Button>
        {detail && <FloorDetailGrid coverage={coverage} />}
      </div>
    </div>
  );
}

/** 逐层方格：每格一层，固定尺寸换行，每 10 层一组并在组下方标出起点楼层。 */
function FloorDetailGrid({ coverage }: { coverage: CoverageViewModel }) {
  const statuses = coverage.runs.flatMap((run) =>
    Array.from({ length: run.to - run.from + 1 }, () => run.status),
  );
  const groups: { start: number; statuses: CoverageStatus[] }[] = [];
  for (let start = 0; start < statuses.length; start += FLOOR_GROUP_SIZE) {
    groups.push({ start, statuses: statuses.slice(start, start + FLOOR_GROUP_SIZE) });
  }
  return (
    <div className="ste:rounded-md ste:bg-muted/60 ste:p-2">
      <div className="ste:flex ste:flex-wrap ste:gap-x-2 ste:gap-y-1.5">
        {groups.map((group) => (
          <div key={group.start} className="ste:flex ste:flex-col ste:gap-1">
            <div className="ste:flex ste:gap-0.5">
              {group.statuses.map((status, index) => (
                <span
                  key={index}
                  title={`#${group.start + index} · ${COVERAGE_STATUS_LABELS[status]}`}
                  data-coverage-floor={group.start + index}
                  className={cn("ste:h-3 ste:w-1.5 ste:rounded-[2px]", coverageClasses[status])}
                />
              ))}
            </div>
            <span className="ste:text-center ste:text-[10px] ste:leading-none ste:tabular-nums ste:text-muted-foreground">
              {group.start}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TaskProgressBar({ task }: { task: FillTaskView }) {
  if (task.kind !== "floor") return null;
  const total = Math.max(0, task.totalCount);
  const processed = Math.min(Math.max(0, task.processedCount), total);
  const percent = total === 0 ? 0 : Math.round((processed / total) * 100);
  return (
    <div className="ste:flex ste:flex-col ste:gap-1.5">
      <div className="ste:flex ste:items-center ste:justify-between ste:gap-2 ste:text-xs">
        <span className="ste:text-muted-foreground">
          已处理 {processed}/{total} 层
        </span>
        <span className="ste:tabular-nums ste:text-muted-foreground">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label="当前填表任务进度"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={processed}
        aria-valuetext={`已处理 ${processed}/${total} 层`}
        className="ste:h-1.5 ste:w-full ste:overflow-hidden ste:rounded-full ste:bg-muted"
      >
        <div
          className="ste:h-full ste:rounded-full ste:bg-primary ste:transition-[width] ste:duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
