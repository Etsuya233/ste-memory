import { Button, Input, Textarea } from "../kit/controls.tsx";
import { ListGroup } from "../kit/list.tsx";
import type { EmbeddingConnection } from "../../features/settings/embedding-connection.ts";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { MemoryRecordId, MemorySpaceId, MemoryTableId } from "../../features/memory/index.ts";
import type {
  RetrievalRange,
  RetrievalSelection,
  VectorRetrievalService,
} from "../../features/vector-retrieval/vector-retrieval-service.ts";

import { Disclosure } from "../shell/disclosure.tsx";
import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBarAction } from "../shell/panel-bar.tsx";
import { Tabs } from "../kit/tabs.tsx";

export function RetrievalTab(props: {
  readonly service: Pick<
    VectorRetrievalService,
    "getState" | "subscribe" | "ranges" | "search" | "cancel"
  >;
  readonly active?: boolean;
  readonly connection: EmbeddingConnection | undefined;
  readonly spaceId: MemorySpaceId | null;
  readonly onRecord: (tableId: MemoryTableId, recordId: MemoryRecordId) => void;
  readonly onIndex: () => void;
  readonly onSettings: () => void;
}) {
  const state = useSyncExternalStore(
    props.service.subscribe,
    props.service.getState,
    props.service.getState,
  );
  const rangeId = useId();
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState("10");
  const [threshold, setThreshold] = useState("");
  const [custom, setCustom] = useState(false);
  const [selection, setSelection] = useState<readonly RetrievalSelection[]>([]);
  const [ranges, setRanges] = useState<readonly RetrievalRange[]>([]);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const running = ["checking", "embedding", "sorting"].includes(state.status);
  useEffect(() => {
    setQuery("");
    setTopK("10");
    setThreshold("");
    setCustom(false);
    setSelection([]);
  }, [state.epoch]);
  useEffect(() => {
    if (!props.spaceId) {
      setRanges([]);
      return;
    }
    let cancelled = false;
    void props.service
      .ranges(props.spaceId)
      .then((rows) => {
        if (!cancelled) {
          setRanges(rows);
          setRangeError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setRangeError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [props.service, props.spaceId, state.epoch, state.dataVersion]);
  useEffect(() => {
    if (!running || state.startedAt === null) return;
    const timer = setInterval(() => setElapsed(Date.now() - state.startedAt!), 100);
    return () => clearInterval(timer);
  }, [running, state.startedAt]);
  function toggleGroup(tableId: MemoryTableId, groupId: string, checked: boolean): void {
    setSelection((previous) => {
      const ids = previous.find((range) => range.tableId === tableId)?.groupIds ?? [];
      return [
        ...previous.filter((range) => range.tableId !== tableId),
        { tableId, groupIds: checked ? [...ids, groupId] : ids.filter((id) => id !== groupId) },
      ].filter((range) => range.groupIds.length > 0);
    });
  }
  const result = state.result;
  const labels = {
    idle: "待搜索",
    checking: "检查候选",
    embedding: "生成查询向量",
    sorting: "本地排序",
    done: "完成",
    cancelled: "已取消",
    stale: "已过期",
    error: "失败",
  };
  return (
    <div className="stm-retrieval" data-stm-retrieval>
      {(props.active ?? true) && (
        <PageChrome
          headerTrailing={
            <PanelBarAction icon="fa-database" label="管理与补建索引" onClick={props.onIndex} />
          }
        />
      )}
      {!props.spaceId ? <p role="alert">请先绑定有效记忆空间。</p> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void props.service.search({
            query,
            topK: Number(topK),
            minimumScore: threshold === "" ? null : Number(threshold),
            selection: custom ? selection : null,
          });
        }}
      >
        <label className="stm-retrieval-query">
          <span>查询</span>
          <Textarea
            data-action="retrieval-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="想找哪段记忆？描述人物、事件或关键词…"
            rows={3}
          />
        </label>
        <p className="stm-setting-hint">
          {query.trim().length}/{Math.min(props.connection?.maxInputChars ?? 4000, 4000)} 字符
        </p>
        <div className="stm-retrieval-submit">
          <Button
            variant="primary"
            type="submit"
            data-action="retrieval-search"
            disabled={!props.spaceId || running}
          >
            搜索记忆
          </Button>
          {running && (
            <Button
              type="button"
              data-action="retrieval-cancel"
              onClick={() => props.service.cancel()}
            >
              取消搜索
            </Button>
          )}
        </div>
        <Disclosure
          icon="fa-sliders"
          title="搜索选项"
          meta={`最多 ${topK} 条 · ${custom ? "自选范围" : "全部表"}`}
          className="stm-retrieval-options"
          data-retrieval-options
        >
          <div className="stm-retrieval-options-body">
            <div className="stm-action-row">
              <label>
                Top K
                <Input
                  data-action="retrieval-top-k"
                  type="number"
                  min="1"
                  max="50"
                  step="1"
                  value={topK}
                  onChange={(event) => setTopK(event.target.value)}
                />
              </label>
              <label>
                最低分（留空关闭）
                <Input
                  data-action="retrieval-threshold"
                  type="number"
                  min="-1"
                  max="1"
                  step="any"
                  value={threshold}
                  onChange={(event) => setThreshold(event.target.value)}
                />
              </label>
            </div>
            <Tabs
              label="搜索范围"
              value={custom ? "custom" : "all"}
              options={[
                { value: "all", label: "全部表", panelId: `${rangeId}-all` },
                { value: "custom", label: "自选范围", panelId: `${rangeId}-custom` },
              ]}
              onChange={(value) => {
                setCustom(value === "custom");
                if (value === "custom" && !selection.length)
                  setSelection(
                    ranges
                      .filter((range) => !range.error)
                      .map((range) => ({
                        tableId: range.table.id,
                        groupIds: range.groups.map((group) => group.id),
                      })),
                  );
              }}
            />
            <div id={`${rangeId}-all`} role="tabpanel" hidden={custom} className="stm-setting-hint">
              搜索当前空间全部可用索引。
            </div>
            <ListGroup
              id={`${rangeId}-custom`}
              role="tabpanel"
              hidden={!custom}
              className="stm-retrieval-ranges"
            >
              {ranges
                .filter((range) => !range.error)
                .map((range) => (
                  <fieldset key={range.table.id}>
                    <legend>
                      <label>
                        <input
                          type="checkbox"
                          disabled={!custom}
                          checked={
                            !custom ||
                            range.groups.every((group) =>
                              selection.some(
                                (selected) =>
                                  selected.tableId === range.table.id &&
                                  selected.groupIds.includes(group.id),
                              ),
                            )
                          }
                          onChange={(event) =>
                            setSelection((previous) => [
                              ...previous.filter((selected) => selected.tableId !== range.table.id),
                              ...(event.target.checked
                                ? [
                                    {
                                      tableId: range.table.id,
                                      groupIds: range.groups.map((group) => group.id),
                                    },
                                  ]
                                : []),
                            ])
                          }
                        />
                        {range.table.name}
                      </label>{" "}
                      · {range.table.key}
                      {range.error ? ` · 未检索：${range.error}` : ""}
                    </legend>
                    {range.groups.map((group) => (
                      <label key={group.id}>
                        <input
                          type="checkbox"
                          disabled={!custom || !!range.error}
                          checked={
                            custom
                              ? selection.some(
                                  (selected) =>
                                    selected.tableId === range.table.id &&
                                    selected.groupIds.includes(group.id),
                                )
                              : !range.error
                          }
                          onChange={(event) =>
                            toggleGroup(range.table.id, group.id, event.target.checked)
                          }
                        />
                        {group.name}
                        {group.error ? ` · ${group.error}` : ""}
                      </label>
                    ))}
                  </fieldset>
                ))}
            </ListGroup>
          </div>
        </Disclosure>
      </form>
      {state.status !== "idle" && (
        <p role="status" data-retrieval-status={state.status}>
          {labels[state.status]}
          {running
            ? ` · ${(elapsed / 1000).toFixed(1)} 秒`
            : state.elapsedMs !== null
              ? ` · ${(state.elapsedMs / 1000).toFixed(1)} 秒`
              : ""}{" "}
        </p>
      )}
      {rangeError ? <p role="alert">{rangeError}</p> : null}
      {ranges
        .filter((range) => range.error)
        .map((range) => (
          <p role="alert" key={range.table.id}>
            {range.table.name} · {range.error}
          </p>
        ))}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.indexUpdated ? <p>索引已更新，可重新搜索；本次候选与覆盖保留原检查时点。</p> : null}
      {result ? (
        <section data-retrieval-results>
          <h4>
            {state.status === "stale" ? "已过期结果 · " : ""}
            {result.message}
          </h4>
          {result.coverage.ready < result.coverage.expected ? (
            <p className="stm-setting-hint">部分索引可用，结果可能遗漏。</p>
          ) : null}
          <ListGroup as="ol" className="stm-retrieval-hits">
            {result.hits.map((hit) => (
              <li
                key={JSON.stringify([hit.target.table.id, hit.target.record.id])}
                data-retrieval-hit
              >
                <button
                  className="stm-retrieval-hit"
                  type="button"
                  data-action="retrieval-open-record"
                  onClick={() => props.onRecord(hit.target.table.id, hit.target.record.id)}
                >
                  <span className="stm-retrieval-hit-copy">
                    <strong>{hit.target.record.displayText}</strong>
                    <span>
                      {hit.target.table.name} · {hit.target.groupName} · {hit.score.toFixed(4)}
                    </span>
                    <span className="stm-retrieval-hit-preview">{hit.target.input}</span>
                  </span>
                  <i className="fa-solid fa-chevron-right" aria-hidden="true" />
                </button>
                <Disclosure
                  icon="fa-layer-group"
                  title="组分与来源"
                  meta={`${hit.groups.length} 组`}
                >
                  {hit.groups.map((group) => (
                    <div key={group.target.groupId}>
                      <p>
                        {group.target.groupName} · {group.score.toFixed(4)} · 索引更新{" "}
                        {group.vector.updatedAt}
                      </p>
                      <p>字段：{group.target.fields.map((field) => field.name).join("、")}</p>
                      <pre>{group.target.input}</pre>
                    </div>
                  ))}
                  <p>
                    表 {hit.target.table.id} · 记录 {hit.target.record.id}
                  </p>
                </Disclosure>
              </li>
            ))}
          </ListGroup>
          <Disclosure
            icon="fa-chart-simple"
            title="搜索详情与索引覆盖"
            className="stm-retrieval-diagnostics"
            data-retrieval-diagnostics
          >
            <div className="stm-retrieval-options-body">
              <p>
                实际查询：{result.request.query} · Top K {result.request.topK} · 最低分{" "}
                {result.request.minimumScore ?? "关闭"}
              </p>
              <p>
                实际范围：
                {result.ranges
                  .map((range) => {
                    const tableRange = ranges.find((item) => item.table.id === range.tableId);
                    const names = range.groupIds.map(
                      (groupId) =>
                        tableRange?.groups.find((group) => group.id === groupId)?.name ?? groupId,
                    );
                    return `${tableRange?.table.name ?? range.tableId} [${names.join("、")}]`;
                  })
                  .join("；")}
              </p>
              <h5>连接配置身份</h5>
              <pre>{result.profile}</pre>
              <p>
                检查时点 {result.coverage.checkedAt} · {result.coverage.records} 条记录 · 就绪{" "}
                {result.coverage.ready}/{result.coverage.expected} 个非空目标 · 空输入{" "}
                {result.coverage.empty} · 缺失 {result.coverage.missing} · 过期{" "}
                {result.coverage.stale} · 异常 {result.coverage.invalid}
              </p>
              {result.coverage.ready < result.coverage.expected ? (
                <p>部分索引，结果可能遗漏。</p>
              ) : null}
              <p>
                本地检查 {result.timing.check.toFixed(1)} ms · 远端{" "}
                {result.timing.remote.toFixed(1)} ms · 排序 {result.timing.sort.toFixed(1)} ms ·
                总计 {result.timing.total.toFixed(1)} ms · 查询调用 {result.calls}
              </p>
              <div>
                <h5>覆盖与任务明细</h5>
                {[...result.coverage.issues, ...result.coverage.taskStates].map((issue, index) => (
                  <p key={index}>{issue}</p>
                ))}
              </div>
              <p className="stm-setting-hint">
                余弦分数衡量相似程度，不代表事实可信度。最低分关闭时也可能返回低分记录。相同端点和模型名下服务更换权重需强制重算。
              </p>
            </div>
          </Disclosure>
        </section>
      ) : null}
      <Disclosure icon="fa-plug" title="空间与连接" className="stm-retrieval-connection">
        <div className="stm-retrieval-options-body">
          <Button type="button" onClick={props.onSettings}>
            连接设置
          </Button>
          <p>空间：{props.spaceId ?? "未绑定"}</p>
          <p>
            {props.connection
              ? `${props.connection.baseUrl} · ${props.connection.model} · ${props.connection.dimensions ?? "响应决定"} 维`
              : "尚未配置 embedding 连接"}
          </p>
          <p className="stm-setting-hint">
            查询调用 {state.calls} 次；字符数与 token 数不同，超长需缩短查询。
          </p>
          <p className="stm-setting-hint">
            只搜索已有索引，不等待或自动补建。每次搜索最多调用一次
            embedding；索引请求独立运行，已发送的请求取消后仍可能计费。
          </p>
        </div>
      </Disclosure>
    </div>
  );
}
