import { Switch } from "../kit/controls.tsx";
import { Disclosure } from "../shell/disclosure.tsx";
import { Segmented } from "../kit/segmented.tsx";
import { VectorGroupEditor } from "../memory/vector-group-editor.tsx";
import type {
  TablePresetTable,
  TablePresetVectorIndex,
} from "../../features/table-presets/preset-model.ts";

/** 预设中的向量索引：分组以字段 Key 保存，实例化时才换成空间内字段身份。 */
export function PresetVectorIndexEditor(props: {
  readonly table: TablePresetTable;
  readonly readonly: boolean;
  readonly onChange: (value: TablePresetVectorIndex) => void;
}) {
  const config: TablePresetVectorIndex = props.table.vectorIndex ?? {
    enabled: false,
    updateMode: "manual",
    groups: [],
  };
  const enabledFields = props.table.fields.filter((field) => field.enabled);
  const groups = config.groups.map((group, index) => ({
    id: `group-${index}`,
    key: group.key,
    name: group.name,
    fieldIds: group.fieldKeys,
  }));
  const fields = props.table.fields.map((field) => ({
    id: field.key,
    name: field.name,
    enabled: field.enabled,
  }));

  function updateGroups(
    next: readonly { id: string; key: string; name: string; fieldIds: readonly string[] }[],
  ) {
    props.onChange({
      ...config,
      groups: next.map((group) => ({
        key: group.key,
        name: group.name,
        fieldKeys: [...group.fieldIds],
      })),
    });
  }

  return (
    <div className="stm-editor stm-vector-editor" data-stm-section="preset-vector-index">
      <fieldset disabled={props.readonly}>
        <section className="stm-vector-hero" data-state={config.enabled ? "on" : "off"}>
          <div className="stm-vector-hero-head">
            <span className="stm-vector-state">
              <span className="stm-vector-state-dot" aria-hidden="true" />
              索引
            </span>
            <Switch
              role="switch"
              aria-label="启用索引"
              checked={config.enabled}
              onChange={(event) => props.onChange({ ...config, enabled: event.target.checked })}
            />
          </div>
          <div className="stm-vector-hero-numbers">
            <span>
              <strong>{enabledFields.length}</strong> 个启用字段
            </span>
            <span className="stm-vector-hero-groups">{groups.length} 组</span>
          </div>
        </section>

        <section className="stm-vector-card">
          <div className="stm-vector-control">
            <span className="stm-vector-label">更新方式</span>
            <Segmented
              label="更新方式"
              value={config.updateMode}
              options={[
                { value: "manual", label: "手动" },
                { value: "automatic", label: "自动" },
              ]}
              disabled={props.readonly}
              onChange={(updateMode) => props.onChange({ ...config, updateMode })}
            />
          </div>
          <div className="stm-vector-divider" />
          <VectorGroupEditor
            groups={groups}
            fields={fields}
            disabled={props.readonly}
            onChange={updateGroups}
          />
        </section>

        <Disclosure icon="fa-circle-info" title="应用范围">
          <p className="stm-setting-hint">
            分组在创建或应用预设时复制到空间。已有空间独立保存；编辑预设不会发送向量请求。
          </p>
        </Disclosure>
      </fieldset>
    </div>
  );
}
