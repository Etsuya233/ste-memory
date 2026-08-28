Status: ready-for-agent

## Problem Statement

当用户在 SillyTavern 中创建分支对话时，新对话文件继承了原始对话的 `chat_metadata`（包含记忆空间绑定指针），导致两个对话共享同一个 Dexie 记忆空间。此后在任一分支中执行填表、宏展开等操作，修改的都是同一份记忆数据。用户无法让分支对话独立维护自己的记忆空间。

## Solution

在记忆空间绑定中引入对话归属身份（`chatIdentity`），使绑定自身声明"我属于哪个对话"。当用户打开一个分支对话时，检测绑定归属与当前对话不一致，通过阻塞式弹窗强制用户选择：**复制现有空间**（全量克隆六张表）或**创建空空间**（含系统表）。选择后更新绑定指向新空间，分支对话从此拥有独立的记忆边界。

## User Stories

1. 作为一个 SillyTavern 用户，我在角色对话 A 中积累了记忆数据后创建了分支对话 B，我希望打开 B 时插件能检测到这是一个分支并提示我选择记忆空间处理方式，这样我可以让 B 拥有独立的记忆。
2. 作为一个 SillyTavern 用户，当我打开分支对话时，我希望看到一个不可关闭的弹窗，告诉我当前分支继承了哪个记忆空间及其记录数，这样我能做出知情的选择。
3. 作为一个 SillyTavern 用户，我希望弹窗提供"复制现有空间"和"创建空空间"两个选项，这样我能根据需要选择全量复制或从零开始。
4. 作为一个 SillyTavern 用户，当我选择"复制"时，我希望新空间包含原空间的全部数据（表格定义、字段、记录、修订历史、证据），这样分支可以独立继续维护已有记忆。
5. 作为一个 SillyTavern 用户，当我选择"新建"时，我希望新空间自动安装系统表（人物、地点、剧情等），这样宏展开和 Agent 填表可以立即工作。
6. 作为一个 SillyTavern 用户，我希望复制/新建操作在弹窗内显示加载状态，完成后显示成功提示再自动关闭弹窗，这样我知道操作已完成。
7. 作为一个 SillyTavern 用户，如果操作失败，我希望弹窗内显示错误信息和"重试"按钮，这样我可以重试或关闭弹窗稍后处理。
8. 作为一个 SillyTavern 用户，我希望弹窗不可通过点击 X 或按 ESC 关闭，必须做出选择，这样不会意外跳过记忆空间分离。
9. 作为一个 SillyTavern 用户，新空间的名字应该遵循当前对话的命名规则（「角色名 - 对话文件名」），这样我能直观地将空间与对话关联。
10. 作为一个 SillyTavern 用户，我希望在弹窗期间（未做出选择前），插件的填表、宏展开、问答面板等功能被自动禁用，这样不会在共享空间状态下执行写操作。
11. 作为一个 SillyTavern 用户，我在更新插件后首次打开旧对话（v1 绑定），我希望绑定被静默迁移到新版本，不会弹窗干扰，这样向后兼容无感。
12. 作为一个 SillyTavern 用户，我在更新插件后创建的新分支对话，打开时应该被正确检测并弹窗，这样新功能立即生效。
13. 作为一个 SillyTavern 用户，复制操作应该在 Dexie 事务内原子执行，失败时整体回滚不产生半复制状态，这样数据一致性有保障。
14. 作为一个 SillyTavern 用户，复制操作需要为新空间的所有实体（空间、表、字段、记录、历史、证据）生成全新 ID 并重映射外键引用，这样新空间与原空间在物理上完全独立。
15. 作为一个 SillyTavern 用户，我希望复制后的新空间绑定立即写入分支对话的 chat_metadata，这样下次打开同一分支不再弹窗。
16. 作为一个 SillyTavern 用户，我不需要"共享"选项——分支对话要么复制要么新建，没有中间态，这样决策模型简单明确。
17. 作为一个 SillyTavern 用户，如果我在更新插件前已经创建了分支并首次打开，由于 v1 绑定迁移的盲区，该分支不会弹窗——我理解这是一次性边界，后续新分支都会被捕获。
18. 作为一个 SillyTavern 用户，弹窗中显示的原空间信息应包括空间名和记录数，这样我能确认复制的是正确的空间。
19. 作为一个 SillyTavern 用户，`branch-detected` 状态不是 `active`，所有依赖 active 状态的 UI 元素（面板按钮、宏展开等）应该自动响应这一状态变化，不需要额外的门控代码。
20. 作为一个 SillyTavern 用户，复制操作完成后，分支对话的记忆宏展开应该使用新空间的数据，这样生成时注入的是独立空间的记忆。

## Implementation Decisions

### 1. 绑定结构升级（v1 → v2）

`ChatSpaceBinding` 新增 `chatIdentity` 字段：

```typescript
export interface ChatSpaceBinding {
  readonly version: 2;
  readonly spaceId: MemorySpaceId;
  readonly chatIdentity: string; // chatIdentityKey(chat) 的值
}
```

`chatIdentity` 的值由已有的 `chatIdentityKey()` 函数生成（`"char:{characterId}:{chatId}"` 或 `"group:{groupId}:{chatId}"`）。首次创建空间时写入。

**适配器联动**：`StChatAdapter.bindingStore.write` 当前硬编码 `{ version: 1, spaceId }`，需改为写入调用方传入的完整绑定对象（含 `version` 和 `chatIdentity`）。`isChatSpaceBinding` 类型守卫需同时识别 v1（`version === 1`）和 v2（`version === 2 && typeof chatIdentity === "string"`）。

### 2. 集中式版本迁移

`ChatSpaceManager.#syncCurrentChat()` 在读取绑定后、执行业务逻辑前，集中检查绑定版本并就地升级：

- v1 绑定 → 迁移为 v2（补写当前 `chatIdentity`），写回 `chat_metadata`
- v2 绑定 → 正常流程
- 未知版本 → `binding-unrecognized`（现有行为不变）

迁移后，后续逻辑只看当前版本，不散布 `version === x` 判断。

**迁移写回路径**：`readChatSpaceBinding` 是纯读函数，不持有写端口。迁移写回在 `ChatSpaceManager.#syncCurrentChat()` 中执行，通过 `bindingStore.write()` 端口写入升级后的 v2 绑定对象。`bindingStore.write` 需要被改造为接受完整的 `ChatSpaceBinding` 对象（含 version、spaceId、chatIdentity），而非仅 spaceId。

### 3. 分支检测作为新状态

`SpaceContextStatus` 新增 `branch-detected` 态：

```typescript
export type SpaceContextStatus =
  | { readonly kind: "active"; ... }
  | { readonly kind: "branch-detected";
      readonly binding: ChatSpaceBinding;
      readonly space: MemorySpace; }
  | { readonly kind: "unsaved-chat"; ... }
  | { readonly kind: "space-missing"; ... }
  | { readonly kind: "binding-unrecognized"; ... };
```

检测条件：v2 绑定的 `chatIdentity` 与当前 `chatIdentityKey(chat)` 不一致，且空间在本地库中存在。

### 4. `branch-detected` 期间的功能门控

`branch-detected` 不是 `active`，所有依赖 `manager.getStatus()?.kind === "active"` 的功能（填表提交、宏展开、问答面板）自然被阻断，无需额外门控代码。UI 弹窗为阻塞式 modal，弹窗期间用户无法操作面板。

### 5. 弹窗 UI 行为

- **载体**：ST Popup API（全屏遮罩）
- **关闭方式**：无 X / ESC，必须点击按钮
- **内容**：展示原空间名 + 记录数，两个按钮（「复制「原空间名」」和「创建空空间」）
- **加载态**：选择后弹窗内显示 loading icon
- **成功态**：显示成功提示后自动关闭弹窗
- **失败态**：弹窗内显示错误 + 「重试」按钮，回到初始状态
- **命名**：新空间名沿用 `buildChatSpaceName(chat)` 规则

### 6. 复制操作（cloneSpace）

在 `DexieMemoryBackupRepository` 上新增 `cloneSpace` 方法，不修改 core 的 `MemoryBackupRepository` 端口（这是 Dexie 实现层的扩展，非跨平台契约）：

- 读取源空间的完整 `MemorySpaceBackup` 单元（复用 `loadSnapshot` 中的空间过滤逻辑）
- 为所有实体生成全新 ID：space → `createId("space")`，table → `createId("table")`，field → `createId("field")`，record → `createId("record")`，history → `createId("record-history")`，evidence → `createId("evidence")`
- 构建旧 ID → 新 ID 的映射表，重映射所有外键引用：`table.memorySpaceId`、`field.tableId`、`field.referenceTableId`（如非 null）、`record.tableId`、`record.revisionId`、`history.recordId`、`history.previousRevisionId`、`history.revisionId`、`evidence` 行级 `memorySpaceId`
- 证据行通过 `toEvidenceRow` 转换时写入新 `memorySpaceId`
- 在 Dexie 读写事务（六张表）内原子写入新单元
- 返回新 spaceId
- `createId` 工厂由调用方注入（与 `MemoryRecordService` 等服务同模式）

### 7. 新建操作

复用 `ChatSpaceManager.#syncCurrentChat()` 中已有的首次创建逻辑：`spaces.create(buildChatSpaceName(chat))` + `installer.install(space.id)`。系统表模板来自共享包。

### 8. 操作后绑定更新

两种操作完成后，均更新分支对话的 `chat_metadata.steMemory` 绑定：

```typescript
adapter.bindingStore.write({
  version: 2,
  spaceId: newSpaceId,
  chatIdentity: chatIdentityKey(currentChat) ?? "",
});
```

### 9. v1 迁移盲区

v1 绑定被分支继承时，迁移会把分支的 `chatIdentity` 写入，导致后续永远检测不到这是分支。这是已接受的一次性边界：用户更新插件后，只要打开过一次原对话（v1 → v2 迁移），后续所有新分支都会被捕获。

### 10. 检测时机

在 `onChatChanged` 事件回调中，`syncToCurrentChat()` 返回 `branch-detected` 状态后，UI 层收到状态变化事件并弹出 ST Popup。弹窗关闭（操作完成）后，UI 层再调一次 `syncToCurrentChat()` 收敛到 `active`。

## Testing Decisions

- 测试应覆盖 `ChatSpaceManager` 的纯逻辑层，使用已有的 `createHarness` / `chatContext` 测试工具，通过端口注入 fake 实现
- 重点测试场景：
  - v1 绑定首次打开：静默迁移为 v2，状态 active(created)，chatMetadata 中绑定已更新
  - v2 绑定 + chatIdentity 匹配：正常 active
  - v2 绑定 + chatIdentity 不匹配 + 空间存在：branch-detected，携带 space 信息
  - v2 绑定 + chatIdentity 不匹配 + 空间缺失：space-missing（降级兜底）
  - v1 绑定 + chatIdentity 不匹配（迁移盲区）：迁移为 v2 后正常 active（不弹窗）
  - cloneSpace：六张表全量复制 + ID 重生成 + 外键重映射 + 事务原子性
  - cloneSpace 失败：事务回滚，无半复制数据
  - bindingStore.write 接受完整 v2 对象：写入 chatMetadata 后读取一致
  - isChatSpaceBinding 识别 v1 和 v2：v1 = bound，v2 = bound，其他 = unrecognized
- 前置先例：`chat-space-manager.test.ts` 已有 15+ 个状态转换测试，新增测试沿用同一模式

## Out of Scope

- 云同步（R2）对分支检测的交互：云同步是独立的 LWW 通道，不影响本地分支检测逻辑
- 对话文件镜像（`steMemoryMirror`）的分支处理：镜像随聊天文件走，分支自动继承，不在本 spec 范围内
- "共享"选项：用户明确表示不需要
- v1 迁移盲区的 `main_chat` fallback 检测：不引入对 ST 约定的依赖

## Further Notes

- 分支检测依赖 ST 的 `CHAT_CHANGED` 事件。如果 ST 未来改变分支创建流程（不触发 `CHAT_CHANGED`），检测会失效，但这是 ST 侧的 breaking change
- `chatIdentityKey` 已存在于代码库中（用于镜像同步的身份跟踪），本复用不引入新概念
- 弹窗的 DOM 实现依赖 ST Popup API 的可用性；如果目标 ST 版本不支持自定义 HTML Popup，需要降级为面板内 banner
