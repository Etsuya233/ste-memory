import { useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import type { VectorPreview } from "../../../features/vector-index/types.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import { Badge } from "../../../ui/primitives/badge.tsx";
import { Field, FieldGroup, FieldLabel } from "../../../ui/primitives/field.tsx";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "../../../ui/primitives/card.tsx";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "../../../ui/primitives/item.tsx";
import { Skeleton } from "../../../ui/primitives/skeleton.tsx";
import { PageEmpty, PageError, StatusNotice } from "../../components/page-state.tsx";
import type { TablesWorkspace, VectorRecordPreview } from "./tables-workspace.ts";

const statusLabels: Record<VectorPreview["status"], string> = {
  ready: "可生成",
  empty: "输入为空",
  too_long: "输入超长",
  unavailable: "连接不可用",
  configuration_invalid: "配置失效",
};

export function VectorPreviewContent({
  workspace,
  preview,
}: {
  workspace: TablesWorkspace;
  preview: VectorRecordPreview;
}) {
  const [search, setSearch] = useState(preview.search);
  return (
    <div className="ste:flex ste:min-w-0 ste:flex-col ste:gap-5">
      <StatusNotice>
        {preview.configuration ? "正在预览未保存的向量草稿。" : "正在预览已保存的向量配置。"}
        这里只生成本地输入，不调用 Embedding 服务，也不创建索引任务。
      </StatusNotice>
      {preview.record ? (
        <p className="ste:text-sm ste:break-words" data-testid="vector-preview-record-title">
          {preview.record.displayText}
        </p>
      ) : (
        <form
          className="ste:flex ste:items-end ste:gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void workspace.loadVectorRecords(1, search);
          }}
        >
          <FieldGroup className="ste:min-w-0 ste:flex-1">
            <Field>
              <FieldLabel htmlFor="vector-preview-search">查找记录</FieldLabel>
              <Input
                id="vector-preview-search"
                value={search}
                disabled={preview.loading}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="输入显示文本"
              />
            </Field>
          </FieldGroup>
          <Button
            type="submit"
            variant="outline"
            size="icon"
            aria-label="搜索预览记录"
            disabled={preview.loading}
          >
            <Search />
          </Button>
        </form>
      )}
      {preview.error ? (
        <PageError
          title="向量预览失败"
          error={preview.error}
          onRetry={() =>
            void (preview.record
              ? workspace.selectVectorRecord(preview.record.id)
              : workspace.loadVectorRecords(preview.page))
          }
        />
      ) : null}
      {preview.loading ? (
        <div
          role="status"
          aria-label="正在加载向量预览"
          className="ste:flex ste:flex-col ste:gap-3"
        >
          <Skeleton className="ste:h-20" />
          <Skeleton className="ste:h-20" />
        </div>
      ) : preview.record ? (
        <>
          {preview.groups.length ? (
            preview.groups.map((group) => (
              <Card key={group.groupId} size="sm" data-vector-group={group.groupId}>
                <CardHeader>
                  <CardTitle className="ste:break-words">{group.groupName}</CardTitle>
                  <CardDescription className="ste:flex ste:flex-wrap ste:items-center ste:gap-2">
                    <Badge
                      variant={
                        group.status === "ready"
                          ? "secondary"
                          : group.status === "configuration_invalid" || group.status === "too_long"
                            ? "destructive"
                            : "outline"
                      }
                    >
                      {statusLabels[group.status]}
                    </Badge>
                    <span>{group.input.length} 字符</span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="ste:flex ste:flex-col ste:gap-3">
                  {group.error ? (
                    <p
                      role="note"
                      className="ste:text-sm ste:text-muted-foreground ste:break-words"
                    >
                      {group.error}
                    </p>
                  ) : null}
                  <pre
                    data-testid="vector-preview-input"
                    className="ste:max-w-full ste:text-sm ste:break-words ste:whitespace-pre-wrap ste:select-text"
                  >
                    {group.input || "（空输入）"}
                  </pre>
                </CardContent>
              </Card>
            ))
          ) : (
            <PageEmpty
              title="没有向量分组"
              description={
                preview.configuration
                  ? "当前草稿没有可预览的分组，请返回检查分组或启用字段。"
                  : "当前表的索引可能已停用，或没有可用分组。可返回编辑向量配置后预览草稿。"
              }
            />
          )}
        </>
      ) : (
        <>
          {preview.records?.records.length ? (
            <ItemGroup>
              {preview.records.records.map((record) => (
                <Item
                  key={record.id}
                  render={<button type="button" />}
                  variant="outline"
                  data-action="open-vector-record"
                  onClick={() => void workspace.selectVectorRecord(record.id)}
                  className="ste:cursor-pointer ste:text-left ste:hover:bg-muted"
                >
                  <ItemContent>
                    <ItemTitle>{record.displayText}</ItemTitle>
                    <ItemDescription>{record.id}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ChevronRight />
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          ) : (
            <PageEmpty
              title="没有可预览的记录"
              description={
                preview.search ? "更换查找文本，或清空后重新搜索。" : "先在记录页为这张表添加记录。"
              }
            />
          )}
          {preview.records ? (
            <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-between ste:gap-3">
              <p className="ste:text-xs ste:text-muted-foreground">
                {preview.records.total} 条记录 · 第 {preview.records.page} /{" "}
                {Math.max(1, preview.records.totalPages)} 页
              </p>
              <div className="ste:flex ste:gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={preview.page <= 1}
                  onClick={() => void workspace.loadVectorRecords(preview.page - 1)}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={preview.page >= preview.records.totalPages}
                  onClick={() => void workspace.loadVectorRecords(preview.page + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
