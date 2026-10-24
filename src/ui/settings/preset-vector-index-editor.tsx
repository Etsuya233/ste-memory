import { Disclosure } from "../shell/disclosure.tsx";
import type {
  TablePresetTable,
  TablePresetVectorIndex,
} from "../../features/table-presets/preset-model.ts";

export function PresetVectorIndexEditor(props: {
  readonly table: TablePresetTable;
  readonly readonly: boolean;
  readonly onChange: (value: TablePresetVectorIndex) => void;
}) {
  const config = props.table.vectorIndex ?? {
    enabled: false,
    updateMode: "manual" as const,
    groups: [],
  };
  const enabledFields = props.table.fields.filter((field) => field.enabled);
  return (
    <div className="stm-editor stm-vector-editor" data-stm-section="preset-vector-index">
      <div className="stm-editor-title">向量索引预设</div>

      <fieldset disabled={props.readonly}>
        <label className="stm-form-row">
          <span className="stm-form-label">启用索引</span>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => props.onChange({ ...config, enabled: event.target.checked })}
          />
        </label>
        <label className="stm-form-row">
          <span className="stm-form-label">更新方式</span>
          <select
            className="stm-input"
            value={config.updateMode}
            onChange={(event) =>
              props.onChange({
                ...config,
                updateMode: event.target.value as TablePresetVectorIndex["updateMode"],
              })
            }
          >
            <option value="manual">手动更新</option>
            <option value="automatic">自动更新</option>
          </select>
        </label>
        {config.groups.map((group, groupIndex) => (
          <div className="stm-vector-group" key={groupIndex}>
            <div className="stm-vector-group-head">
              <input
                className="stm-input"
                aria-label={`向量分组 ${groupIndex + 1} 名称`}
                value={group.name}
                onChange={(event) =>
                  props.onChange({
                    ...config,
                    groups: config.groups.map((item, index) =>
                      index === groupIndex ? { ...item, name: event.target.value } : item,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="stm-table-action"
                disabled={groupIndex === 0}
                onClick={() =>
                  props.onChange({ ...config, groups: moved(config.groups, groupIndex, -1) })
                }
              >
                上移
              </button>
              <button
                type="button"
                className="stm-table-action"
                disabled={groupIndex === config.groups.length - 1}
                onClick={() =>
                  props.onChange({ ...config, groups: moved(config.groups, groupIndex, 1) })
                }
              >
                下移
              </button>
              <button
                type="button"
                className="stm-table-action stm-table-action--danger"
                onClick={() =>
                  props.onChange({
                    ...config,
                    groups: config.groups.filter((_, index) => index !== groupIndex),
                  })
                }
              >
                删除组
              </button>
            </div>
            {group.fieldKeys.map((key, fieldIndex) => {
              const field = props.table.fields.find((item) => item.key === key);
              return (
                <div className="stm-vector-field" key={`${key}-${fieldIndex}`}>
                  <span className={field?.enabled ? "" : "stm-form-error"}>
                    {field
                      ? `${field.name}${field.enabled ? "" : "（已停用）"}`
                      : `已删除字段 ${key}`}
                  </span>
                  <button
                    type="button"
                    className="stm-table-action"
                    disabled={fieldIndex === 0}
                    onClick={() =>
                      props.onChange({
                        ...config,
                        groups: config.groups.map((item, index) =>
                          index === groupIndex
                            ? { ...item, fieldKeys: moved(item.fieldKeys, fieldIndex, -1) }
                            : item,
                        ),
                      })
                    }
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="stm-table-action"
                    disabled={fieldIndex === group.fieldKeys.length - 1}
                    onClick={() =>
                      props.onChange({
                        ...config,
                        groups: config.groups.map((item, index) =>
                          index === groupIndex
                            ? { ...item, fieldKeys: moved(item.fieldKeys, fieldIndex, 1) }
                            : item,
                        ),
                      })
                    }
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="stm-table-action stm-table-action--danger"
                    onClick={() =>
                      props.onChange({
                        ...config,
                        groups: config.groups.map((item, index) =>
                          index === groupIndex
                            ? {
                                ...item,
                                fieldKeys: item.fieldKeys.filter((_, i) => i !== fieldIndex),
                              }
                            : item,
                        ),
                      })
                    }
                  >
                    移除
                  </button>
                </div>
              );
            })}
            <select
              className="stm-input"
              aria-label={`给 ${group.name} 添加字段`}
              value=""
              onChange={(event) =>
                props.onChange({
                  ...config,
                  groups: config.groups.map((item, index) =>
                    index === groupIndex
                      ? { ...item, fieldKeys: [...item.fieldKeys, event.target.value] }
                      : item,
                  ),
                })
              }
            >
              <option value="">添加字段</option>
              {enabledFields
                .filter((field) => !group.fieldKeys.includes(field.key))
                .map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.name}
                  </option>
                ))}
            </select>
          </div>
        ))}
        <button
          type="button"
          className="stm-button"
          onClick={() =>
            props.onChange({
              ...config,
              groups: [
                ...config.groups,
                { name: `分组 ${config.groups.length + 1}`, fieldKeys: [] },
              ],
            })
          }
        >
          新增分组
        </button>
      </fieldset>
      <Disclosure icon="fa-circle-info" title="应用范围">
        <p className="stm-setting-hint">
          分组在创建或应用预设时复制到空间。已有空间独立保存；编辑预设不会发送向量请求。
        </p>
      </Disclosure>
    </div>
  );
}

function moved<T>(values: readonly T[], index: number, delta: number): T[] {
  const next = [...values];
  [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
  return next;
}
