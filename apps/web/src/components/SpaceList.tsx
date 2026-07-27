import { MessageSquareText, Pencil, Trash2 } from "lucide-react";
import type { MemorySpace } from "../api/memory-spaces.ts";

interface SpaceListProps {
  readonly spaces: readonly MemorySpace[];
  readonly selectedId?: string;
  readonly onDelete: (space: MemorySpace) => void;
  readonly onRename: (space: MemorySpace) => void;
  readonly onSelect: (id: string) => void;
}

export function SpaceList({ spaces, selectedId, onDelete, onRename, onSelect }: SpaceListProps) {
  if (spaces.length === 0) {
    return (
      <div className="empty-list">
        <MessageSquareText size={24} />
        <p>尚未创建记忆空间</p>
      </div>
    );
  }

  return (
    <div className="space-list">
      {spaces.map((space) => (
        <article
          className={`space-item ${space.id === selectedId ? "selected" : ""}`}
          key={space.id}
        >
          <button className="space-select" type="button" onClick={() => onSelect(space.id)}>
            <strong>{space.name}</strong>
            <span>
              {space.messageCount} 条消息
              {space.errorCount > 0 ? ` · ${space.errorCount} 个错误` : ""}
            </span>
          </button>
          <div className="space-actions">
            <button
              className="icon-button"
              type="button"
              title="重命名"
              aria-label={`重命名 ${space.name}`}
              onClick={() => onRename(space)}
            >
              <Pencil size={15} />
            </button>
            <button
              className="icon-button danger"
              type="button"
              title="删除"
              aria-label={`删除 ${space.name}`}
              onClick={() => onDelete(space)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
