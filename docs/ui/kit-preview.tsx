import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "../../src/ui/kit/theme.tsx";
import { ActionGroup, IconButton } from "../../src/ui/kit/actions.tsx";
import { Button, FormField, FormRow, Input, Select, Switch, Textarea } from "../../src/ui/kit/controls.tsx";
import { ActionMenu } from "../../src/ui/kit/action-menu.tsx";
import { Dialog } from "../../src/ui/kit/dialog.tsx";
import { Disclosure } from "../../src/ui/kit/disclosure.tsx";
import { ListGroup, ListRow, ListSection, NavigationRow } from "../../src/ui/kit/list.tsx";
import { Segmented } from "../../src/ui/kit/segmented.tsx";
import { Tabs } from "../../src/ui/kit/tabs.tsx";
import "../../src/ui/kit/theme.css";
import "../../src/ui/kit/components.css";
import "./kit-preview.css";

function Sample({ appearance, dark, accent }: { appearance: "glass" | "classic" | "material"; dark: boolean; accent: string }) {
  const [enabled, setEnabled] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState("剧情记忆");
  const [selection, setSelection] = useState("manual");
  const [tab, setTab] = useState("settings");
  const [notice, setNotice] = useState("");
  return <Theme theme={{ appearance, tone: dark ? "dark" : "light", background: dark ? "#101014" : "#f2f2f7", accent, accentForeground: "#fff" }} className="sample" data-sample={appearance}>
    <header className="sample-bar">
      <ActionGroup><IconButton label="返回"><span>‹</span></IconButton></ActionGroup>
      <span>{appearance === "glass" ? "Liquid Glass" : appearance === "classic" ? "Classic" : "Material"}</span>
      <ActionGroup><ActionMenu label="更多操作" actions={[
        { id: "edit", label: "编辑预设", onSelect: () => setDialog(true) },
        { id: "disabled", label: "暂不可用", disabled: true, onSelect: () => undefined },
        { id: "copy", label: "复制预设", onSelect: () => setNotice("已复制预设") },
        { id: "delete", label: "删除预设", danger: true, onSelect: () => setNotice("示例：已删除预设") },
      ]} renderTrigger={({ "aria-label": label, ...props }) => <IconButton {...props} label={label!}>•••</IconButton>} /></ActionGroup>
    </header>
    <main className="sample-content">
      <h1>设置</h1>
      <Tabs label="页面" value={tab} onChange={setTab} options={[
        { value: "settings", label: "设置", panelId: `${appearance}-settings` },
        { value: "records", label: "记录", panelId: `${appearance}-records` },
      ]} />
      <div role="tabpanel" id={`${appearance}-${tab}`} className="sample-body">
        {tab === "settings" ? <>
          <ListGroup><ListRow title="插件总开关" description="关闭后暂停绑定与同步" trailing={<Switch label="插件总开关" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />} /></ListGroup>
          <ListSection title="记忆与提示词">
            <ListGroup>
              <NavigationRow title="记忆宏" description="2 个全局宏 · 1 个对话宏" onClick={() => setDialog(true)} />
              <NavigationRow title="表格预设" description={`当前：${name}`} onClick={() => setDialog(true)} />
              <NavigationRow title="Agent 提示词预设" description="包含较长说明的列表项会自然换行，在窄屏中仍能阅读完整内容。" onClick={() => setDialog(true)} />
            </ListGroup>
          </ListSection>
          <ListSection title="连接与更新">
            <ListGroup>
              <ListRow title="连接状态" trailing="已连接" />
              <ListRow title="自动更新" trailing={<Switch label="自动更新" defaultChecked />} />
              <NavigationRow title="受限操作" description="此项暂不可用" disabled />
            </ListGroup>
          </ListSection>
          <Disclosure title="更新方式" leading={<span>↻</span>}>
            <Segmented label="更新方式" value={selection} onChange={setSelection} options={[{ value: "manual", label: "手动" }, { value: "automatic", label: "自动" }]} />
          </Disclosure>
          <ListSection title="横向表单行">
            <FormRow label="独立名称" hint="单独使用时自带分组表面">{(field) => <Input {...field} value={name} onChange={(event) => setName(event.target.value)} />}</FormRow>
          </ListSection>
          <ListSection title="与列表组合"><ListGroup>
            <FormRow label="名称">{(field) => <Input {...field} value={name} onChange={(event) => setName(event.target.value)} />}</FormRow>
            <FormRow label="连接">{(field) => <Select {...field}><option>跟随当前连接</option><option>独立连接</option></Select>}</FormRow>
            <FormRow label="必填名称" error={name.trim() ? undefined : "请输入名称"}>{(field) => <Input {...field} value={name} onChange={(event) => setName(event.target.value)} />}</FormRow>
          </ListGroup></ListSection>
          <FormField label="预设名称" hint="仅用于区分预设">{(field) => <Input {...field} value={name} onChange={(event) => setName(event.target.value)} />}</FormField>
          <FormField label="必填示例" error={name.trim() ? undefined : "请输入预设名称"}>{(field) => <Input {...field} value={name} onChange={(event) => setName(event.target.value)} />}</FormField>
          <FormField label="连接">{(field) => <Select {...field}><option>跟随当前连接</option><option>独立连接</option></Select>}</FormField>
          <FormField label="说明">{(field) => <Textarea {...field} rows={2} placeholder="填写预设说明" />}</FormField>
          <div className="sample-actions"><Button disabled>不可用</Button><Button variant="primary" onClick={() => setNotice("已保存")}>保存</Button></div>
        </> : <ListSection title="最近的记录"><ListGroup>
          <NavigationRow title="第一次相遇" description="在雨后的街角，两人交换了名字。" onClick={() => setDialog(true)} />
          <NavigationRow title="新的约定" description="下次见面时带上那本书。" onClick={() => setDialog(true)} />
        </ListGroup></ListSection>}
        <div role="status">{notice}</div>
      </div>
    </main>
    {dialog && <Dialog label="编辑预设" onClose={() => setDialog(false)}>
      <div className="sample-editor"><h2>编辑预设</h2><FormField label="名称">{(field) => <Input {...field} value={name} onChange={(event) => setName(event.target.value)} />}</FormField><Button variant="primary" onClick={() => setDialog(false)}>完成</Button></div>
    </Dialog>}
  </Theme>;
}

function Preview() {
  const [dark, setDark] = useState(false);
  const [accent, setAccent] = useState("#2563eb");
  return <><div className="preview-toolbar"><strong>公共组件预览</strong><label><input type="checkbox" checked={dark} onChange={(event) => setDark(event.target.checked)} /> 深色</label><label>强调色 <input type="color" value={accent} onChange={(event) => setAccent(event.target.value)} /></label></div><div className="preview-grid">{(["glass", "classic", "material"] as const).map((appearance) => <Sample key={appearance} appearance={appearance} dark={dark} accent={accent} />)}</div></>;
}

createRoot(document.getElementById("root")!).render(<Preview />);
