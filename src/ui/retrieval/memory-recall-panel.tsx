import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  MemoryRecallService,
  RecallConfiguration,
} from "../../features/vector-retrieval/memory-recall-service.ts";
import type { MemoryRecordId, MemoryTableId } from "../../features/memory/index.ts";

export function MemoryRecallPanel({
  service,
  onRecord,
}: {
  readonly service: MemoryRecallService;
  readonly onRecord: (table: MemoryTableId, record: MemoryRecordId) => void;
}) {
  const state = useSyncExternalStore(service.subscribe, service.getState, service.getState);
  const retrieval = service.getRetrieval();
  const retrievalState = useSyncExternalStore(
    retrieval.subscribe,
    retrieval.getState,
    retrieval.getState,
  );
  const [draft, setDraft] = useState<RecallConfiguration>(state.configuration);
  const [choices, setChoices] = useState<Awaited<ReturnType<MemoryRecallService["choices"]>>>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(state.configuration);
  }, [state.configuration]);
  useEffect(() => {
    let active = true;
    void service
      .choices()
      .then((value) => {
        if (active) setChoices(value);
      })
      .catch((error: unknown) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [
    service,
    state.configuration,
    state.status,
    retrievalState.dataVersion,
    retrievalState.epoch,
  ]);
  return (
    <section className="stm-retrieval stm-memory-recall" data-stm-memory-recall>
      <details className="stm-recall-configuration" data-recall-configuration>
        <summary>
          自动召回{" "}
          <span>
            {state.configuration.enabled
              ? `已开启 · ${state.configuration.bindings.length} 个视图`
              : "未开启"}
          </span>
        </summary>
        <div className="stm-retrieval-options-body">
          <details>
            <summary>宏用法与召回规则</summary>{" "}
            <p className="stm-setting-hint">
              将 {"{{memoryRecall}}"}{" "}
              放进角色卡或提示词预设。开启后每次发送都会检索，即使提示词未使用宏。最多等待 10
              秒，可跳过；失败时使用空宏继续。独立 dry run 的 token
              预估不包含召回文本；与真实发送并发时可能计入，均不额外请求 embedding。
            </p>
          </details>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              try {
                service.saveConfiguration(draft);
                setError("");
              } catch (error) {
                setError(String(error));
              }
            }}
          >
            <label>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              启用当前对话自动召回
            </label>
            {choices.length === 0 && (
              <p className="stm-setting-hint">
                当前没有可绑定的命名视图。请在设置的记忆视图／对话宏中新建视图，并为所属表启用向量索引。
              </p>
            )}
            {choices.map(({ scope, view, range }) => {
              const binding = draft.bindings.find(
                (binding) => binding.scope === scope && binding.name === view.name,
              );
              return (
                <fieldset key={`${scope}/${view.name}`}>
                  <legend>
                    <label>
                      <input
                        type="checkbox"
                        checked={Boolean(binding)}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            bindings: event.target.checked
                              ? [
                                  ...draft.bindings,
                                  {
                                    scope,
                                    name: view.name,
                                    tableKey: view.tableKey,
                                    groupIds: range?.error
                                      ? []
                                      : (range?.groups
                                          .filter((group) => !group.error)
                                          .map((group) => group.id) ?? []),
                                  },
                                ]
                              : draft.bindings.filter((item) => item !== binding),
                          })
                        }
                      />
                      {scope === "global" ? "全局" : "对话"} / {view.name} ·{" "}
                      {range?.table.name ?? view.tableKey}
                    </label>
                  </legend>
                  <p>
                    {view.condition
                      ? `${view.condition.fieldKey} ∈ ${view.condition.values.join("、")}`
                      : "无筛选条件"}{" "}
                    {range?.error ?? ""}
                  </p>
                  {binding &&
                    (binding.tableKey !== view.tableKey ||
                      binding.groupIds.some(
                        (id) => !range?.groups.some((group) => group.id === id && !group.error),
                      )) && (
                      <p role="alert">视图所属表或已选向量组已失效，请取消勾选该视图后重新选择。</p>
                    )}
                  {binding &&
                    range?.groups.map((group) => (
                      <label key={group.id}>
                        <input
                          type="checkbox"
                          checked={binding.groupIds.includes(group.id)}
                          disabled={Boolean(group.error)}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              bindings: draft.bindings.map((item) =>
                                item === binding
                                  ? {
                                      ...item,
                                      groupIds: event.target.checked
                                        ? [...item.groupIds, group.id]
                                        : item.groupIds.filter((id) => id !== group.id),
                                    }
                                  : item,
                              ),
                            })
                          }
                        />
                        {group.name} {group.error}
                      </label>
                    ))}
                </fieldset>
              );
            })}
            {draft.bindings
              .filter(
                (binding) =>
                  !choices.some(
                    (choice) => choice.scope === binding.scope && choice.view.name === binding.name,
                  ),
              )
              .map((binding) => (
                <p role="alert" key={`${binding.scope}/${binding.name}`}>
                  失效绑定：{binding.scope}/{binding.name}{" "}
                  <button
                    className="stm-button"
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        bindings: draft.bindings.filter((item) => item !== binding),
                      })
                    }
                  >
                    移除
                  </button>
                </p>
              ))}
            <div className="stm-action-row">
              <label>
                Top K
                <input
                  className="stm-input"
                  type="number"
                  min={1}
                  max={50}
                  value={draft.topK}
                  onChange={(event) => setDraft({ ...draft, topK: Number(event.target.value) })}
                />
              </label>
              <label>
                最低分（留空关闭）
                <input
                  className="stm-input"
                  type="number"
                  min={-1}
                  max={1}
                  step="any"
                  value={draft.minimumScore ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      minimumScore: event.target.value === "" ? null : Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                输出字符上限
                <input
                  className="stm-input"
                  type="number"
                  min={500}
                  value={draft.maxChars}
                  onChange={(event) => setDraft({ ...draft, maxChars: Number(event.target.value) })}
                />
              </label>
            </div>
            <button className="stm-button" type="submit">
              保存当前对话召回配置
            </button>
          </form>
        </div>
      </details>
      {error && <p role="alert">{error}</p>}
      <p role="status" className="stm-recall-status" data-recall-status={state.status}>
        {state.message} · {state.elapsedMs} ms · 输出 {state.outputCount} 条
        {state.status === "preparing" &&
          ` · ${retrievalState.status === "embedding" ? "生成查询向量" : retrievalState.status === "sorting" ? "本地排序" : "检查候选范围"}`}
      </p>
      {state.status === "preparing" && (
        <button className="stm-button" type="button" onClick={service.skip}>
          跳过本次召回
        </button>
      )}
      {state.query && (
        <details>
          <summary>实际查询与范围</summary>
          <pre>{state.query}</pre>
          {state.ranges.map((range, index) => (
            <p key={index}>
              {range.scope}/{range.name} · {range.tableKey} ·{" "}
              {range.condition
                ? `${range.condition.fieldKey} ∈ ${range.condition.values.join("、")}`
                : "无条件"}{" "}
              · {range.groupIds.join("、")} · 匹配 {range.matched} 条
            </p>
          ))}
        </details>
      )}
      <details>
        <summary>实际宏文本</summary>
        <pre>{state.text || "（空）"}</pre>
      </details>
      {state.status === "done" && <RecallHits service={service} onRecord={onRecord} />}
    </section>
  );
}

function RecallHits({
  service,
  onRecord,
}: {
  readonly service: MemoryRecallService;
  readonly onRecord: (table: MemoryTableId, record: MemoryRecordId) => void;
}) {
  const retrieval = service.getRetrieval();
  const state = useSyncExternalStore(retrieval.subscribe, retrieval.getState, retrieval.getState);
  const result = state.result;
  return result ? (
    <details>
      <summary>
        召回命中与索引覆盖：{result.hits.length} 条 · {result.coverage.ready}/
        {result.coverage.expected}
      </summary>
      <p>
        实际 Top K {result.request.topK}；最低分 {result.request.minimumScore ?? "关闭"}；查询请求{" "}
        {result.calls} 次。 检查 {result.coverage.checkedAt}；远端{" "}
        {Math.round(result.timing.remote)} ms；本地{" "}
        {Math.round(result.timing.check + result.timing.sort)} ms
      </p>
      <p>
        缺失 {result.coverage.missing}；过期 {result.coverage.stale}；异常 {result.coverage.invalid}
        ；空内容 {result.coverage.empty}
      </p>
      {state.indexUpdated && <p>索引已有更新，下次发送将使用新索引；本次保留原候选快照。</p>}
      {result.hits.map((hit) => (
        <p key={hit.target.record.id}>
          <button
            className="stm-button"
            type="button"
            onClick={() => onRecord(hit.target.table.id, hit.target.record.id)}
          >
            {hit.target.record.displayText}
          </button>{" "}
          · {hit.score.toFixed(4)} · {hit.groups.map((group) => group.target.groupName).join("、")}
        </p>
      ))}
      {result.coverage.issues.map((issue) => (
        <p key={issue}>{issue}</p>
      ))}
      {result.coverage.taskStates.map((task, index) => (
        <p key={index}>{task}</p>
      ))}
    </details>
  ) : null;
}
