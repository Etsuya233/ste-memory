import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import { createUiId } from "../shell/ui-helpers.tsx";

/** 分组编辑器只关心“字段 id + 显示名 + 是否可用”，表配置和预设共用同一套结构。 */
export interface VectorFieldOption {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
}

export interface VectorGroupDraft {
  readonly id: string;
  readonly name: string;
  readonly fieldIds: readonly string[];
}

/**
 * 向量分组编辑：组名、字段芯片与组级操作。
 * 字段顺序直接决定输入拼接顺序，因此用拖拽（含键盘）而不是上下移按钮。
 */
export function VectorGroupEditor(props: {
  readonly groups: readonly VectorGroupDraft[];
  readonly fields: readonly VectorFieldOption[];
  readonly disabled?: boolean;
  readonly onChange: (groups: readonly VectorGroupDraft[]) => void;
}) {
  return (
    <div className="stm-vector-groups" data-stm-section="vector-groups">
      {props.groups.map((group, index) => (
        <VectorGroupCard
          key={group.id}
          group={group}
          index={index}
          total={props.groups.length}
          fields={props.fields}
          disabled={props.disabled ?? false}
          onChange={(next) =>
            props.onChange(props.groups.map((item) => (item.id === group.id ? next : item)))
          }
          onMove={(delta) => props.onChange(move(props.groups, index, delta))}
          onRemove={() => props.onChange(props.groups.filter((item) => item.id !== group.id))}
        />
      ))}
      <button
        type="button"
        className="stm-vector-add-group"
        disabled={props.disabled}
        onClick={() =>
          props.onChange([
            ...props.groups,
            {
              id: createUiId(),
              name: `分组 ${props.groups.length + 1}`,
              fieldIds: [],
            },
          ])
        }
      >
        <i className="fa-solid fa-plus" aria-hidden="true" />
        新增分组
      </button>
    </div>
  );
}

function VectorGroupCard(props: {
  readonly group: VectorGroupDraft;
  readonly index: number;
  readonly total: number;
  readonly fields: readonly VectorFieldOption[];
  readonly disabled: boolean;
  readonly onChange: (group: VectorGroupDraft) => void;
  readonly onMove: (delta: number) => void;
  readonly onRemove: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const fieldsById = new Map(props.fields.map((field) => [field.id, field]));
  const candidates = props.fields.filter(
    (field) => field.enabled && !props.group.fieldIds.includes(field.id),
  );

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = props.group.fieldIds.indexOf(String(active.id));
    const to = props.group.fieldIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    props.onChange({
      ...props.group,
      fieldIds: arrayMove([...props.group.fieldIds], from, to),
    });
  }

  function updateFieldIds(fieldIds: readonly string[]): void {
    props.onChange({ ...props.group, fieldIds });
  }

  return (
    <article
      className="stm-vector-group"
      data-stm-section="vector-group"
      data-menu-open={menuOpen ? "true" : undefined}
    >
      <header className="stm-vector-group-head">
        <input
          className="stm-vector-group-name"
          value={props.group.name}
          placeholder="分组名称"
          aria-label={`分组 ${props.index + 1} 名称`}
          disabled={props.disabled}
          onChange={(event) => props.onChange({ ...props.group, name: event.target.value })}
        />
        <button
          type="button"
          className="stm-vector-group-menu-button"
          aria-label={`分组 ${props.group.name || props.index + 1} 操作`}
          aria-expanded={menuOpen}
          disabled={props.disabled}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <i className="fa-solid fa-ellipsis" aria-hidden="true" />
        </button>
      </header>
      {menuOpen ? (
        <div className="stm-vector-group-menu">
          <button type="button" disabled={props.index === 0} onClick={() => props.onMove(-1)}>
            上移
          </button>
          <button
            type="button"
            disabled={props.index === props.total - 1}
            onClick={() => props.onMove(1)}
          >
            下移
          </button>
          <button type="button" className="is-danger" onClick={props.onRemove}>
            删除分组
          </button>
        </div>
      ) : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={[...props.group.fieldIds]} strategy={rectSortingStrategy}>
          <ul className="stm-vector-chips">
            {props.group.fieldIds.map((fieldId) => {
              const field = fieldsById.get(fieldId);
              return (
                <SortableFieldChip
                  key={fieldId}
                  id={fieldId}
                  label={field ? field.name : "已删除字段"}
                  invalid={!field || !field.enabled}
                  disabled={props.disabled}
                  onRemove={() =>
                    updateFieldIds(props.group.fieldIds.filter((id) => id !== fieldId))
                  }
                />
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>
      <select
        className="stm-vector-add-field"
        value=""
        aria-label={`给 ${props.group.name} 添加字段`}
        disabled={props.disabled || candidates.length === 0}
        onChange={(event) => {
          if (event.target.value) updateFieldIds([...props.group.fieldIds, event.target.value]);
        }}
      >
        <option value="">＋ 字段</option>
        {candidates.map((field) => (
          <option key={field.id} value={field.id}>
            {field.name}
          </option>
        ))}
      </select>
    </article>
  );
}

function SortableFieldChip(props: {
  readonly id: string;
  readonly label: string;
  readonly invalid: boolean;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: props.disabled,
  });
  return (
    <li
      ref={setNodeRef}
      className="stm-vector-chip"
      data-invalid={props.invalid ? "true" : undefined}
      data-dragging={isDragging ? "true" : undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="stm-vector-chip-label"
        aria-label={`拖动 ${props.label} 排序`}
        disabled={props.disabled}
        {...attributes}
        {...listeners}
      >
        {props.label}
      </button>
      <button
        type="button"
        className="stm-vector-chip-remove"
        aria-label={`移除 ${props.label}`}
        disabled={props.disabled}
        onClick={props.onRemove}
      >
        <i className="fa-solid fa-xmark" aria-hidden="true" />
      </button>
    </li>
  );
}

function move<T>(items: readonly T[], index: number, delta: number): T[] {
  const next = [...items];
  const target = index + delta;
  if (target < 0 || target >= next.length) return next;
  const current = next[index]!;
  next[index] = next[target]!;
  next[target] = current;
  return next;
}
