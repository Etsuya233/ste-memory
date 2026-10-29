import type { FillTaskView } from "../../../features/fill-tasks/fill-task.ts";
import {
  COVERAGE_STATUS_LABELS,
  type CoverageStatus,
  type CoverageViewModel,
} from "../../models/tasks/task-panel-model.ts";
import { cn } from "../../../ui/primitives/utils.ts";

const coverageClasses: Record<CoverageStatus, string> = {
  processed: "ste:bg-muted-foreground",
  running: "ste:bg-primary",
  error: "ste:bg-destructive",
  untracked: "ste:bg-border",
};

type CoverageCount = "processedCount" | "runningCount" | "errorCount" | "untrackedCount";

const coverageLegend: readonly { status: CoverageStatus; count: CoverageCount }[] = [
  { status: "processed", count: "processedCount" },
  { status: "running", count: "runningCount" },
  { status: "error", count: "errorCount" },
  { status: "untracked", count: "untrackedCount" },
];

export function CoverageBar({ coverage }: { coverage: CoverageViewModel }) {
  if (coverage.totalCount === 0) return null;
  const summary = coverageLegend
    .map(({ status, count }) => `${COVERAGE_STATUS_LABELS[status]} ${coverage[count]}`)
    .join("，");
  return (
    <div className="ste:flex ste:flex-col ste:gap-2">
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
            style={{ flexGrow: run.to - run.from + 1, flexBasis: 0 }}
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
