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
      <div className="empty-state">
        <MessageSquareText size={26} />
        <strong>尚未创建记忆空间</strong>
        <p>点击顶栏「创建空间」上传一份聊天 JSONL 开始实验。</p>
      </div>
    );
  }

  return (
    <div className="side-list">
      {spaces.map((space) => (
        <article
          className={`side-list-item ${space.id === selectedId ? "selected" : ""}`}
          key={space.id}
        >
          <button className="side-list-main" type="button" onClick={() => onSelect(space.id)}>
            <span className="side-list-icon">
              <MessageSquareText size={14} />
            </span>
            <span className="side-list-copy">
              <strong>{space.name}</strong>
              <small>
                {space.messageCount} 条消息
                {space.errorCount > 0 ? ` · ${space.errorCount} 个错误` : ""}
              </small>
            </span>
          </button>
          <div className="side-list-actions">
            <button
              className="icon-btn"
              type="button"
              title="重命名"
              aria-label={`重命名 ${space.name}`}
              onClick={() => onRename(space)}
            >
              <Pencil size={13} />
            </button>
            <button
              className="icon-btn danger"
              type="button"
              title="删除"
              aria-label={`删除 ${space.name}`}
              onClick={() => onDelete(space)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
