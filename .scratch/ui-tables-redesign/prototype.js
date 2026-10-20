(() => {
  "use strict";

  /* ============================================================
   * 数据
   * ============================================================ */

  const TYPE = {
    short_text: { label: "短文本", glyph: "Aa" },
    long_text: { label: "长文本", glyph: "¶" },
    short_text_list: { label: "短文本列表", glyph: "≡" },
    integer: { label: "整数", glyph: "#" },
    decimal: { label: "小数", glyph: "#." },
    boolean: { label: "布尔", glyph: "◐" },
    date: { label: "日期", glyph: "◷" },
    datetime: { label: "日期时间", glyph: "◷" },
    single_select: { label: "单选", glyph: "▾" },
    multi_select: { label: "多选", glyph: "▾" },
    single_reference: { label: "单引用", glyph: "↗" },
    multi_reference: { label: "多引用", glyph: "⇉" },
  };

  const field = (name, key, type, extra = {}) => ({
    id: key,
    name,
    key,
    type,
    required: false,
    enabled: true,
    ref: null,
    dep: false,
    prompt: "",
    ...extra,
  });

  const INITIAL_TABLES = [
    {
      id: "characters",
      name: "人物",
      key: "characters",
      system: true,
      enabled: true,
      description: "持续维护人物身份、特征、经历与当前状态。",
      prompt:
        "记录会话中具有独立身份且值得持续记忆的人物。相同身份只维护一条记录；只写证据支持的内容；事件过程不要写进本表。",
      strategy: { mode: "field", field: "name", template: "" },
      fields: [
        field("名称", "name", "short_text", { required: true, dep: true }),
        field("别名", "aliases", "short_text_list"),
        field("身份/定位", "role", "short_text"),
        field("性格特征", "personality", "long_text"),
        field("外貌特征", "appearance", "long_text"),
        field("背景/经历", "background", "long_text", { enabled: false }),
        field("当前状态", "current_status", "long_text"),
      ],
    },
    {
      id: "relationships",
      name: "人际关系",
      key: "relationships",
      system: true,
      enabled: true,
      description: "维护人物对之间的关系认知、现状与关键事实。",
      prompt: "每对人物维护一条关系记录；本表只记录关系本身的稳定定性、里程碑事实与此刻状态。",
      strategy: { mode: "template", field: "summary", template: "{人物 A} ↔ {人物 B}" },
      fields: [
        field("人物 A", "character_a", "single_reference", { required: true, ref: "人物", dep: true }),
        field("人物 B", "character_b", "single_reference", { required: true, ref: "人物", dep: true }),
        field("关系定性", "summary", "long_text"),
        field("当前状态", "current_status", "long_text"),
        field("关键事实", "key_facts", "long_text"),
      ],
    },
    {
      id: "locations",
      name: "地点",
      key: "locations",
      system: true,
      enabled: true,
      description: "维护地点属性、位置文本、状态及关联对象。",
      prompt: "记录具有可辨识身份、可能再次出现或影响剧情的地点；只写固定属性与此刻正在发生什么。",
      strategy: { mode: "field", field: "name", template: "" },
      fields: [
        field("名称", "name", "short_text", { required: true, dep: true }),
        field("地点类型", "type", "short_text"),
        field("固定描述", "details", "long_text"),
        field("当前状态", "current_status", "long_text"),
        field("相关人物", "related_characters", "multi_reference", { ref: "人物" }),
        field("相关物品", "related_items", "multi_reference", { ref: "物品" }),
      ],
    },
    {
      id: "items",
      name: "物品",
      key: "items",
      system: true,
      enabled: true,
      description: "维护物品类型、归属、位置、状态与关键属性。",
      prompt: "只记录具有剧情作用、归属意义或需要持续追踪的物品；使用过程与事件细节不要写进本表。",
      strategy: { mode: "field", field: "name", template: "" },
      fields: [
        field("名称", "name", "short_text", { required: true, dep: true }),
        field("物品类型", "type", "short_text"),
        field("持有者/所属人物", "owner", "single_reference", { ref: "人物" }),
        field("当前位置", "current_location", "single_reference", { ref: "地点" }),
        field("状态", "status", "single_select"),
        field("关键属性", "key_attributes", "long_text"),
      ],
    },
    {
      id: "plots",
      name: "剧情",
      key: "plots",
      system: true,
      enabled: true,
      description: "维护持续发展的剧情事件及其参与对象和状态。",
      prompt: "一条记录表示一个能够跨越多个场景持续发展的剧情事件；本表是事件唯一归位处。",
      strategy: { mode: "field", field: "name", template: "" },
      fields: [
        field("名称", "name", "short_text", { required: true, dep: true }),
        field("进度摘要", "details", "long_text"),
        field("相关人物", "related_characters", "multi_reference", { ref: "人物" }),
        field("相关地点", "related_locations", "multi_reference", { ref: "地点" }),
        field("状态", "status", "single_select"),
        field("发生时间", "time_hint", "short_text"),
      ],
    },
    {
      id: "foreshadowing",
      name: "伏笔",
      key: "foreshadowing",
      system: true,
      enabled: true,
      description: "维护尚未闭环的叙事线索及其计划回收信息。",
      prompt: "只立重要且有回收价值的线索；本表只写线索本身与回收信息，事件经过不要写进本表。",
      strategy: { mode: "field", field: "name", template: "" },
      fields: [
        field("名称", "name", "short_text", { required: true, dep: true }),
        field("线索", "setup", "long_text"),
        field("相关人物", "related_characters", "multi_reference", { ref: "人物" }),
        field("相关地点", "related_locations", "multi_reference", { ref: "地点" }),
        field("状态", "status", "single_select"),
        field("计划回收信息", "resolution_plan", "long_text"),
      ],
    },
    {
      id: "todos",
      name: "待办",
      key: "todos",
      system: true,
      enabled: true,
      description: "维护明确提出且尚需执行的行动事项。",
      prompt: "记录角色或剧情明确提出、尚需执行的行动事项；已完成或已放弃的事项清空详情。",
      strategy: { mode: "field", field: "name", template: "" },
      fields: [
        field("名称", "name", "short_text", { required: true, dep: true }),
        field("行动内容", "details", "long_text"),
        field("相关人物", "related_characters", "multi_reference", { ref: "人物" }),
        field("相关地点", "related_locations", "multi_reference", { ref: "地点" }),
        field("优先级", "priority", "single_select"),
        field("状态", "status", "single_select"),
        field("期望时间", "relative_due", "short_text"),
      ],
    },
    {
      id: "story_state",
      name: "世界状态",
      key: "story_state",
      system: true,
      enabled: true,
      description: "维护剧情世界的当前状态快照（时间、地点、天气、服装）；全表仅一条记录。",
      prompt: "本表维护剧情世界的当前状态快照，是剧情时钟的唯一载体；更新时覆盖旧值，绝不新建第二条。",
      strategy: { mode: "field", field: "name", template: "" },
      fields: [
        field("名称", "name", "short_text", { required: true, dep: true }),
        field("当前时间", "current_time", "short_text"),
        field("当前地点", "current_location", "short_text"),
        field("天气", "weather", "short_text"),
        field("当日着装", "clothing", "short_text"),
      ],
    },
  ];

  const SAMPLES = {
    characters: {
      name: "艾琳·卡斯特",
      aliases: "银翼、艾琳",
      role: "猎魔人",
      personality: "冷静、寡言，对承诺异常执着",
      appearance: "银灰长发，左眉有一道旧疤",
      background: "北境佣兵团的幸存者",
      current_status: "与霍克结盟中，正在调查西北塔",
    },
    relationships: {
      character_a: "艾琳·卡斯特",
      character_b: "霍克",
      summary: "互相试探的盟友",
      current_status: "共同处理宅邸中的异常",
      key_facts: "曾在北境有过一次失败的交易",
    },
    locations: {
      name: "雾雨宅邸",
      type: "宅邸",
      details: "坐落在城西高地，常年被雾气包围",
      current_status: "晚宴准备中，西翼封闭",
      related_characters: "艾琳、霍克",
      related_items: "银质怀表",
    },
    items: {
      name: "银质怀表",
      type: "饰品",
      owner: "霍克",
      current_location: "雾雨宅邸",
      status: "可用",
      key_attributes: "表盖内侧刻着一行看不清的旧字",
    },
    plots: {
      name: "西北塔的封印",
      details: "塔顶的符文开始失效，宅邸中的异常与此有关。",
      related_characters: "艾琳、霍克",
      related_locations: "西北塔",
      status: "进行中",
      time_hint: "第 3 天·傍晚",
    },
    foreshadowing: {
      name: "黑鸦的第三次出现",
      setup: "每次有人提起旧宅主，黑鸦都会出现在西翼窗台。",
      related_characters: "霍克",
      related_locations: "雾雨宅邸",
      status: "埋设中",
      resolution_plan: "在塔顶封印解除后回收",
    },
    todos: {
      name: "修复西北塔的封印",
      details: "在月相改变前找到塔顶符文的替代品。",
      related_characters: "艾琳",
      related_locations: "西北塔",
      priority: "高",
      status: "待处理",
      relative_due: "今晚",
    },
    story_state: {
      name: "世界状态",
      current_time: "第 3 天·傍晚",
      current_location: "雾雨宅邸",
      weather: "雨",
      clothing: "艾琳穿着灰色旅行斗篷",
    },
  };

  const CONCEPT_INFO = {
    workbench: {
      num: "01",
      name: "结构工作台",
      recommend: true,
      tagline: "左侧表索引，右侧单表结构。桌面双栏，手机两级钻取。",
      mini: "split",
      why: [
        "一屏只展开一张表，页面高度不再随表格数量增长。",
        "表级操作收进详情页签，字段操作收进「排序」。",
        "桌面左右独立滚动；手机列表 → 详情钻取，永远不会出现八张表同时展开。",
      ],
      path: ["表索引", "选择表格", "字段 / 信息 / 策略", "点字段行编辑"],
      tradeoff:
        "桌面双栏会占用宽度；手机需要一次返回。比起“一屏扫完所有表”，它更强调专注当前表。",
      landing:
        "推荐先落地。现有 TablesTab 可拆成索引 + 详情；表格编辑器进「表格信息」，DisplayStrategyEditor 进「显示策略」，字段编辑器改成弹层。",
    },
    library: {
      num: "02",
      name: "表格库",
      recommend: false,
      tagline: "卡片总览 + 侧滑检视器。先看全貌，再进入单表编辑。",
      mini: "grid",
      why: [
        "卡片压缩成三列 / 两列，八张表一屏内可扫完。",
        "卡片只保留启用开关与「⋯」，不再有四颗常驻按钮。",
        "点击卡片打开检视器，编辑动作集中在一个上下文里，关闭即回到总览。",
      ],
      path: ["卡片墙", "打开检视器", "字段 / 信息 / 策略", "关闭返回"],
      tradeoff:
        "编辑时多一层遮罩；卡片描述只能显示两行。对“表很多、主要看结构”的场景更友好，对连续改多张表的效率略低。",
      landing:
        "作为总览页很合适。检视器可以复用工作台的详情组件；卡片墙本身可以放在「表格」Tab 的默认视图。",
    },
    focus: {
      num: "03",
      name: "单表聚焦 · 字段矩阵",
      recommend: false,
      tagline: "一个下拉切换表，字段以矩阵呈现；界面只服务当前表。",
      mini: "matrix",
      why: [
        "字段是最常编辑的对象，用行列对齐替代卡片堆叠，垂直高度最小。",
        "一屏能看到全部字段；每行只留一个开关，编辑在点击行之后发生。",
        "表格信息与显示策略收进「⋯」弹层，不占主界面。",
      ],
      path: ["表名下拉", "字段矩阵", "点行编辑", "⋯ 打开信息 / 策略"],
      tradeoff:
        "跨表对比不如前两个方向直观；移动端矩阵要降级为两行卡片。适合重度维护字段结构的用户。",
      landing:
        "可以先只把字段区做成矩阵，嵌进工作台的右栏；表切换器复用记录页的 chips 逻辑即可。",
    },
  };

  const COMMON_PRINCIPLES = [
    "一次只展开一张表；列表只负责导航，不再承载编辑器。",
    "表级操作 = 启用 + 一个「⋯」；字段级操作 = 行内开关 + 点击行编辑。",
    "危险操作离开主路径：删除收进表格信息页底部或操作菜单。",
    "滚动发生在单个区域内部（列表 / 详情 / 矩阵），而不是整页无限增长。",
  ];

  const createInitialData = () =>
    INITIAL_TABLES.map((table) => ({
      ...table,
      fields: table.fields.map((item) => ({ ...item })),
      strategy: { ...table.strategy },
    }));

  /* ============================================================
   * 状态与工具
   * ============================================================ */

  const state = {
    concept: "workbench",
    viewport: "mobile",
    selectedId: "characters",
    tab: "fields",
    fieldMode: false,
    mobileView: "list",
    inspectorOpen: false,
    modal: null,
    search: "",
    pickerSearch: "",
    appearanceOpen: false,
    toast: null,
    focusTarget: null,
  };

  let data = { tables: createInitialData() };
  let toastTimer = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) => {
      const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
      return map[char];
    });

  const icon = (name, cls = "") =>
    `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  const typeMeta = (type) => TYPE[type] || TYPE.short_text;
  const typeLabel = (type) => typeMeta(type).label;
  const typeGlyph = (type) => typeMeta(type).glyph;

  const getTable = (id = state.selectedId) =>
    data.tables.find((table) => table.id === id) || null;

  const enabledFieldCount = (table) => table.fields.filter((item) => item.enabled).length;

  const totalFieldCount = () => data.tables.reduce((sum, table) => sum + table.fields.length, 0);

  const strategySummary = (table) => {
    if (!table.strategy || table.strategy.mode === "template") return "模板显示";
    const target =
      table.fields.find((item) => item.key === table.strategy.field) || table.fields[0] || null;
    return target ? `显示：${target.name}` : "显示：未设置";
  };

  const matchesSearch = (table, query) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      table.name.toLowerCase().includes(q) ||
      table.key.toLowerCase().includes(q) ||
      table.description.toLowerCase().includes(q)
    );
  };

  const initialOf = (table) => (table.name ? table.name.slice(0, 1) : "表");

  const renderSwitch = (checked, action, attrs, options = {}) => {
    const classes = `switch${options.sm ? " switch--sm" : ""}`;
    const title = options.title ? ` title="${esc(options.title)}"` : "";
    const label = esc(options.label || "切换");
    const disabled = options.disabled ? ' disabled aria-disabled="true"' : "";
    return `<button type="button" class="${classes}" role="switch" aria-checked="${checked ? "true" : "false"}" aria-label="${label}" data-action="${action}" ${attrs}${title}${disabled}><span class="switch-track"></span></button>`;
  };

  const fieldBadges = (item) => {
    const parts = [];
    if (item.required) parts.push('<span class="badge badge--warn">必填</span>');
    if (item.ref) parts.push(`<span class="badge badge--accent">→ ${esc(item.ref)}</span>`);
    if (item.dep) parts.push('<span class="badge badge--soft">显示依赖</span>');
    return parts.join("");
  };

  const strategyPreview = (table) => {
    const samples = SAMPLES[table.id] || {};
    if (table.strategy.mode === "template") {
      const template = table.strategy.template || "";
      return (
        template.replace(/\{([^}]+)\}/g, (_, token) => {
          const clean = token.trim();
          const fieldItem =
            table.fields.find((item) => item.name === clean || item.key === clean) || null;
          return fieldItem ? samples[fieldItem.key] || `〔${fieldItem.name}〕` : "…";
        }) || "（还没有模板）"
      );
    }
    const target =
      table.fields.find((item) => item.key === table.strategy.field) || table.fields[0] || null;
    return target ? samples[target.key] || `〔${target.name} 示例〕` : "（未选择显示字段）";
  };

  const groupTables = (tables) => {
    const system = tables.filter((table) => table.system);
    const custom = tables.filter((table) => !table.system);
    return [
      { label: "系统表", tables: system },
      { label: "自定义表", tables: custom },
    ].filter((group) => group.tables.length > 0);
  };

  /* ============================================================
   * 渲染：外壳
   * ============================================================ */

  function renderPanelBar({ variant = "root", leading = "", title = "", subtitle = "", trailing = "" }) {
    return `
      <header class="panel-bar panel-bar--${variant}">
        <div class="panel-bar-leading">${leading}</div>
        <div class="panel-bar-title">
          <div class="panel-bar-title-text">${esc(title)}</div>
          ${subtitle ? `<div class="panel-bar-title-sub">${esc(subtitle)}</div>` : ""}
        </div>
        <div class="panel-bar-trailing">${trailing}</div>
      </header>`;
  }

  function renderTopbar() {
    return renderPanelBar({
      leading: `<button type="button" class="icon-btn" data-action="nav-hint" aria-label="打开导航">${icon("menu")}</button>`,
      title: "表格",
      trailing: `
        <div class="app-sync"><i class="dot"></i><span>已同步</span></div>
        <button type="button" class="icon-btn" data-action="close-hint" aria-label="收起面板">${icon("x")}</button>`,
    });
  }

  function renderApp() {
    const device = $("#device");
    if (!device) return;
    device.dataset.viewport = state.viewport;

    /* 手机详情是独立的二级页面：标题栏由该页面自己提供，不再叠加全局标题栏。 */
    const standaloneScreen =
      state.concept === "workbench" &&
      state.viewport === "mobile" &&
      state.mobileView === "detail" &&
      Boolean(getTable());

    device.innerHTML = `
      <div class="app">
        ${
          standaloneScreen
            ? renderConcept()
            : `${renderTopbar()}<div class="app-content">${renderConcept()}</div>`
        }
        ${state.toast ? `<div class="toast">${icon("check")}${esc(state.toast)}</div>` : ""}
        ${state.modal ? renderModal() : ""}
      </div>`;

    if (state.focusTarget) {
      const input = $(`[data-search="${state.focusTarget}"]`);
      state.focusTarget = null;
      if (input) {
        input.focus();
        const length = input.value.length;
        try { input.setSelectionRange(length, length); } catch { /* noop */ }
      }
    }
  }

  function renderConcept() {
    if (state.concept === "library") return renderLibrary();
    if (state.concept === "focus") return renderFocus();
    return renderWorkbench();
  }

  function renderNoTables() {
    return `
      <div class="empty-state" style="height:100%">
        <div class="empty-icon">${icon("table")}</div>
        <div class="empty-title">还没有记忆表格</div>
        <div class="empty-desc">表格结构会在这里出现；先新建一张表，或从表格预设应用。</div>
        <button type="button" class="btn btn-primary btn-sm" data-action="new-table">${icon("plus")} 新建表格</button>
      </div>`;
  }

  /* ============================================================
   * 渲染：方向 01 · 结构工作台
   * ============================================================ */

  function renderWorkbench() {
    const table = getTable();
    if (!table) return renderNoTables();

    if (state.viewport === "desktop") {
      return `<div class="wb-desktop">${renderRail()}${renderDetail(table)}</div>`;
    }

    if (state.mobileView === "detail") {
      return `
        <div class="screen">
          ${renderPanelBar({
            variant: "detail",
            leading: `<button type="button" class="panel-bar-back" data-action="back-to-list" aria-label="返回表格索引">
              ${icon("chevron-left")}<span>表格</span>
            </button>`,
            title: table.name,
            subtitle: table.key,
            trailing: renderSwitch(table.enabled, "toggle-table", `data-table-id="${table.id}"`, {
              label: `启用 ${table.name}`,
            }),
          })}
          <div class="screen-body">${renderDetail(table, { mobile: true })}</div>
        </div>`;
    }

    return `<div class="wb-mobile">${renderRail(true)}</div>`;
  }

  function renderRail(mobile = false) {
    const filtered = data.tables.filter((table) => matchesSearch(table, state.search));
    const groups = groupTables(filtered);
    const list = groups.length
      ? groups
          .map(
            (group) => `
              <div class="wb-group">
                <div class="wb-group-label"><span>${group.label}</span><span class="wb-group-count">${group.tables.length}</span></div>
                ${group.tables
                  .map((table) => {
                    const active = table.id === state.selectedId;
                    return `
                      <button type="button" class="wb-table-row${active ? " is-active" : ""}${table.enabled ? "" : " is-off"}" data-action="select-table" data-table-id="${table.id}">
                        <span class="table-glyph">${esc(initialOf(table))}</span>
                        <span class="wb-table-row-main">
                          <span class="wb-table-row-name">${esc(table.name)}</span>
                          <span class="wb-table-row-meta">${table.fields.length} 字段</span>
                        </span>
                        <span class="dot${table.enabled ? "" : " dot--off"}"></span>
                        ${mobile ? `<span class="wb-row-chevron">${icon("chevron-right")}</span>` : ""}
                      </button>`;
                  })
                  .join("")}
              </div>`
          )
          .join("")
      : `<div class="wb-rail-empty">没有匹配「${esc(state.search)}」的表格<br>试试名称或 Key</div>`;

    return `
      <aside class="wb-rail${mobile ? " wb-rail--mobile" : ""}">
        <div class="wb-rail-head">
          <div class="wb-rail-title-row">
            <div>
              <div class="wb-rail-title">表格索引</div>
              <div class="wb-rail-sub">${data.tables.length} 张表 · ${totalFieldCount()} 个字段</div>
            </div>
            <button type="button" class="btn btn-outline btn-xs" data-action="new-table">${icon("plus")} 新建</button>
          </div>
          <div class="wb-search">
            ${icon("search")}
            <input type="search" data-search="tables" value="${esc(state.search)}" placeholder="搜索表格或 Key" aria-label="搜索表格">
          </div>
        </div>
        <div class="wb-list">
          ${list}
        </div>
      </aside>`;
  }

  function renderDetail(table, options = {}) {
    const classes = `detail${options.mobile ? " detail--mobile" : ""}`;
    return `<div class="${classes}">${renderDetailInner(table, options)}</div>`;
  }

  function renderDetailInner(table, options = {}) {
    const mobile = options.mobile === true;
    const tabs = [
      { id: "fields", label: `字段 ${table.fields.length}` },
      { id: "info", label: "表格信息" },
      { id: "strategy", label: "显示策略" },
    ];
    const stats = `
        <div class="detail-stats">
          <span class="badge badge--soft">${table.system ? "系统表" : "自定义表"}</span>
          <span class="dot-sep">·</span>
          <span>${strategySummary(table)}</span>
        </div>`;

    const titleRow = mobile
      ? ""
      : `<div class="detail-title-row">
          <span class="table-glyph table-glyph--lg">${esc(initialOf(table))}</span>
          <div class="detail-title-main">
            <div class="detail-name">${esc(table.name)}</div>
            <div class="detail-key">${esc(table.key)}</div>
          </div>
          <div class="detail-head-actions">
            ${renderSwitch(table.enabled, "toggle-table", `data-table-id="${table.id}"`, {
              label: `启用 ${table.name}`,
            })}
          </div>
        </div>`;

    return `
      <div class="detail-head${mobile ? " detail-head--mobile" : ""}">
        ${titleRow}
        <div class="detail-desc">${esc(table.description || "暂无描述")}</div>
        ${stats}
      </div>
      <div class="detail-tabs">
        <div class="segmented" role="tablist" aria-label="表格详情">
          ${tabs
            .map(
              (tab) =>
                `<button type="button" role="tab" aria-selected="${state.tab === tab.id}" class="${state.tab === tab.id ? "is-active" : ""}" data-action="set-tab" data-tab="${tab.id}">${tab.label}</button>`
            )
            .join("")}
        </div>
      </div>
      <div class="detail-body">${renderTabBody(table)}</div>`;
  }

  function renderTabBody(table) {
    if (state.tab === "info") return renderInfoPanel(table, { scope: "page" });
    if (state.tab === "strategy") return renderStrategyPanel(table, { scope: "page" });
    return renderFieldsPanel(table);
  }

  function renderFieldsPanel(table) {
    const enabled = enabledFieldCount(table);
    const enabledLabel = table.fields.length && enabled === table.fields.length ? "全部启用" : `已启用 ${enabled}`;
    const content = table.fields.length
      ? `<div class="field-list">${table.fields.map((item) => renderFieldRow(table, item)).join("")}</div>`
      : `
        <div class="empty-state" style="padding:32px 16px">
          <div class="empty-icon">${icon("layers")}</div>
          <div class="empty-title">还没有字段</div>
          <div class="empty-desc">先定义字段，记录页和 Agent 才能按结构填写。</div>
          <button type="button" class="btn btn-primary btn-sm" data-action="new-field" data-table-id="${table.id}">${icon("plus")} 新增字段</button>
        </div>`;

    return `
      <div class="fields-panel">
        <div class="fields-toolbar">
          <div class="fields-title">字段<span class="fields-enabled">${enabledLabel}</span></div>
          <div class="fields-actions">
            ${table.fields.length ? `<button type="button" class="btn btn-ghost btn-xs" data-action="toggle-field-mode">${state.fieldMode ? "完成" : "排序"}</button>` : ""}
            <button type="button" class="btn btn-primary btn-xs" data-action="new-field" data-table-id="${table.id}">${icon("plus")} 新增字段</button>
          </div>
        </div>
        ${content}
      </div>`;
  }

  function renderFieldRow(table, item) {
    const index = table.fields.findIndex((fieldItem) => fieldItem.id === item.id);
    return `
      <div class="field-row${item.enabled ? "" : " is-off"}" data-action="edit-field" data-table-id="${table.id}" data-field-id="${item.id}" role="button" tabindex="0">
        ${state.fieldMode ? `<span class="field-drag" aria-hidden="true">${icon("grip")}</span>` : ""}
        <div class="field-main">
          <div class="field-name">${esc(item.name)}${fieldBadges(item)}</div>
          <div class="field-meta">
            <code>${esc(item.key)}</code><span class="dot-sep">·</span><span>${typeLabel(item.type)}</span>${item.ref ? `<span class="dot-sep">·</span><span>${esc(item.ref)}</span>` : ""}
          </div>
        </div>
        ${state.fieldMode ? `
          <div class="field-manage-tools">
            <button type="button" class="row-icon-btn" data-action="move-field-up" data-table-id="${table.id}" data-field-id="${item.id}" ${index === 0 ? "disabled" : ""} aria-label="上移 ${esc(item.name)}">${icon("arrow-up")}</button>
            <button type="button" class="row-icon-btn" data-action="move-field-down" data-table-id="${table.id}" data-field-id="${item.id}" ${index === table.fields.length - 1 ? "disabled" : ""} aria-label="下移 ${esc(item.name)}">${icon("arrow-down")}</button>
          </div>` : ""}
        ${renderSwitch(item.enabled, "toggle-field", `data-table-id="${table.id}" data-field-id="${item.id}"`, {
          label: `启用字段 ${item.name}`,
          disabled: item.dep,
          title: item.dep ? "该字段被显示策略依赖，不能停用" : "",
        })}
      </div>`;
  }

  /* ============================================================
   * 渲染：表格信息 / 显示策略
   * ============================================================ */

  function renderInfoPanel(table, options = {}) {
    const scope = options.scope || "page";
    return `
      <form class="form-stack" data-form="info" data-scope="${scope}" data-table-id="${table.id}">
        <div class="form-grid">
          <label class="form-row">
            <span class="form-label">名称 <em>*</em></span>
            <input class="form-input" name="name" value="${esc(table.name)}" autocomplete="off">
          </label>
          <label class="form-row">
            <span class="form-label">Key <em>*</em></span>
            <input class="form-input" name="key" value="${esc(table.key)}" autocomplete="off">
          </label>
        </div>
        <label class="form-row">
          <span class="form-label">描述</span>
          <input class="form-input" name="description" value="${esc(table.description)}" autocomplete="off">
        </label>
        <label class="form-row">
          <span class="form-label">表格 Prompt</span>
          <textarea class="form-textarea" name="prompt" rows="4">${esc(table.prompt || "")}</textarea>
          <span class="form-hint">给表格填写 Agent 的填表指引；只影响之后的生成，不改已有记录。</span>
        </label>
        <div class="form-actions">
          <button type="reset" class="btn btn-ghost btn-sm">重置</button>
          <button type="submit" class="btn btn-primary btn-sm">保存修改</button>
        </div>
        ${renderDangerZone(table)}
      </form>`;
  }

  function renderDangerZone(table) {
    return `
      <div class="danger-zone">
        <div>
          <div class="danger-title">删除表格</div>
          <div class="danger-desc">将同时删除 ${table.fields.length} 个字段与其中的记录，且不可恢复。</div>
        </div>
        <button type="button" class="btn btn-danger btn-sm" data-action="confirm-delete-table" data-table-id="${table.id}">删除</button>
      </div>`;
  }

  function renderStrategyPanel(table, options = {}) {
    const scope = options.scope || "page";
    const mode = table.strategy.mode;
    const fieldOptions = table.fields
      .map(
        (item) =>
          `<option value="${esc(item.key)}"${item.key === table.strategy.field ? " selected" : ""}>${esc(item.name)}</option>`
      )
      .join("");
    const chips = table.fields
      .map(
        (item) =>
          `<button type="button" class="chip" data-action="insert-token" data-token="{${esc(item.name)}}">${esc(item.name)}</button>`
      )
      .join("");

    return `
      <form class="form-stack" data-form="strategy" data-scope="${scope}" data-table-id="${table.id}">
        <div class="strategy-intro">决定记录在列表、宏与其他表引用中如何显示。显示值不承担记录身份。</div>
        <div class="form-row">
          <span class="form-label">显示方式</span>
          <div class="segmented">
            <button type="button" class="${mode === "field" ? "is-active" : ""}" data-action="strategy-mode" data-mode="field">字段显示</button>
            <button type="button" class="${mode === "template" ? "is-active" : ""}" data-action="strategy-mode" data-mode="template">模板显示</button>
          </div>
        </div>
        ${mode === "field"
          ? `<label class="form-row">
              <span class="form-label">显示字段</span>
              <select class="form-input" name="field" data-strategy-field>${fieldOptions}</select>
            </label>`
          : `<label class="form-row">
              <span class="form-label">显示模板</span>
              <textarea class="form-textarea" name="template" rows="3" data-strategy-template>${esc(table.strategy.template)}</textarea>
              <span class="form-hint">用 {字段名} 插入显示值；引用字段会先解析为对方记录的显示文本。</span>
            </label>
            <div class="form-row">
              <span class="form-label">插入字段</span>
              <div class="chip-row">${chips || '<span class="form-hint">暂无字段</span>'}</div>
            </div>`}
        <div class="strategy-preview">
          <div class="strategy-preview-label">${icon("eye")} 效果预览</div>
          <div class="strategy-preview-text">${esc(strategyPreview(table))}</div>
          <div class="form-hint" style="margin-top:5px">用当前表第一条记录生成的示意文本。</div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary btn-sm">保存显示策略</button>
        </div>
      </form>`;
  }

  /* ============================================================
   * 渲染：方向 02 · 表格库
   * ============================================================ */

  function renderLibrary() {
    const filtered = data.tables.filter((table) => matchesSearch(table, state.search));
    const enabledTables = data.tables.filter((table) => table.enabled).length;
    const cards = filtered.map((table) => renderLibraryCard(table)).join("");
    const grid = `
      <div class="library-grid">
        ${cards}
        <button type="button" class="library-new" data-action="new-table">
          ${icon("plus")}<span>新建表格</span>
        </button>
      </div>`;
    const empty = `<div class="empty-state library-empty">
      <div class="empty-icon">${icon("search")}</div>
      <div class="empty-title">没有匹配的表格</div>
      <div class="empty-desc">试试名称、Key 或描述里的关键词。</div>
    </div>`;

    return `
      <div class="library-screen">
        <div class="library-head">
          <div>
            <div class="library-title">表格库</div>
            <div class="library-sub">${data.tables.length} 张表 · ${totalFieldCount()} 个字段 · ${enabledTables} 张启用</div>
          </div>
          <div class="library-tools">
            <div class="library-search">
              ${icon("search")}
              <input type="search" data-search="tables" value="${esc(state.search)}" placeholder="搜索表格" aria-label="搜索表格">
            </div>
            <button type="button" class="btn btn-primary btn-xs" data-action="new-table">${icon("plus")} 新建</button>
          </div>
        </div>
        ${filtered.length ? grid : empty}
      </div>
      ${state.inspectorOpen ? renderInspector() : ""}`;
  }

  function renderLibraryCard(table) {
    const signatureTypes = [...new Set(table.fields.map((item) => item.type))].slice(0, 4);
    return `
      <article class="library-card${table.enabled ? "" : " is-off"}" data-action="open-inspector" data-table-id="${table.id}" role="button" tabindex="0">
        <div class="library-card-head">
          <span class="table-glyph">${esc(initialOf(table))}</span>
          <div class="library-card-title">
            <div class="library-card-name">${esc(table.name)}</div>
            <div class="library-card-key">${esc(table.key)}</div>
          </div>
          ${renderSwitch(table.enabled, "toggle-table", `data-table-id="${table.id}"`, {
            label: `启用 ${table.name}`,
            sm: true,
          })}
        </div>
        <div class="library-card-desc">${esc(table.description || "暂无描述")}</div>
        <div class="library-signature">
          ${signatureTypes.map((type) => `<span class="sig" title="${typeLabel(type)}">${typeGlyph(type)}</span>`).join("")}
          <span class="sig" title="显示策略">${table.strategy.mode === "template" ? "{}" : "◉"}</span>
        </div>
        <div class="library-card-foot">
          <span>${table.fields.length} 字段</span><span>·</span><span>${enabledFieldCount(table)} 启用</span>
          <button type="button" class="icon-btn icon-btn--xs" data-action="open-table-actions" data-table-id="${table.id}" aria-label="更多表格操作">${icon("more")}</button>
        </div>
      </article>`;
  }

  function renderInspector() {
    const table = getTable();
    if (!table) return "";
    return `
      <div class="inspector-layer">
        <button type="button" class="inspector-scrim" data-action="close-inspector" aria-label="关闭检视器"></button>
        <aside class="inspector" role="dialog" aria-modal="true" aria-label="${esc(table.name)} 表格详情">
          <div class="inspector-head">
            <button type="button" class="icon-btn icon-btn--sm" data-action="close-inspector" aria-label="关闭">${icon("x")}</button>
            <div class="inspector-title">表格详情</div>
            <button type="button" class="icon-btn icon-btn--sm" data-action="open-table-actions" data-table-id="${table.id}" aria-label="更多表格操作">${icon("more")}</button>
          </div>
          ${renderDetail(table)}
        </aside>
      </div>`;
  }

  /* ============================================================
   * 渲染：方向 03 · 单表聚焦
   * ============================================================ */

  function renderFocus() {
    const table = getTable();
    if (!table) return `<div class="focus-empty">${renderNoTables()}</div>`;

    return `
      <div class="focus-screen">
        <div class="focus-head">
          <button type="button" class="table-select" data-action="open-table-picker" aria-label="切换表格">
            <span class="table-glyph">${esc(initialOf(table))}</span>
            <span class="table-select-main">
              <span class="table-select-name">${esc(table.name)}</span>
              <span class="table-select-key">${esc(table.key)}</span>
            </span>
            <span class="table-select-meta">${table.fields.length} 字段</span>
            ${icon("chevron-down")}
          </button>
          <div class="focus-actions">
            ${renderSwitch(table.enabled, "toggle-table", `data-table-id="${table.id}"`, {
              label: `启用 ${table.name}`,
            })}
            <button type="button" class="icon-btn icon-btn--sm" data-action="open-table-actions" data-table-id="${table.id}" aria-label="更多表格操作">${icon("more")}</button>
          </div>
        </div>
        <div class="focus-desc" title="${esc(table.description)}">${esc(table.description || "暂无描述")}</div>
        <div class="focus-stats">
          <span>${table.fields.length} 字段</span>
          <span class="dot-sep">·</span>
          <span>${enabledFieldCount(table)} 启用</span>
          <span class="dot-sep">·</span>
          <span>${strategySummary(table)}</span>
          <span class="badge badge--soft">${table.system ? "系统表" : "自定义表"}</span>
        </div>
        <div class="focus-toolbar">
          <div class="fields-title">字段 <span class="count">${table.fields.length}</span><span class="muted">${enabledFieldCount(table)} 启用</span></div>
          <div class="fields-actions">
            ${table.fields.length ? `<button type="button" class="btn btn-ghost btn-xs" data-action="toggle-field-mode">${state.fieldMode ? "完成" : "管理"}</button>` : ""}
            <button type="button" class="btn btn-primary btn-xs" data-action="new-field" data-table-id="${table.id}">${icon("plus")} 新增字段</button>
          </div>
        </div>
        <div class="focus-matrix">${renderMatrix(table)}</div>
        <div class="focus-foot">点击字段行编辑；开关只控制是否启用。表格信息与显示策略在「⋯」中。</div>
      </div>`;
  }

  function renderMatrix(table) {
    if (!table.fields.length) {
      return `<div class="empty-state" style="padding:40px 16px">
        <div class="empty-icon">${icon("layers")}</div>
        <div class="empty-title">还没有字段</div>
        <div class="empty-desc">先定义字段，记录页和 Agent 才能按结构填写。</div>
        <button type="button" class="btn btn-primary btn-sm" data-action="new-field" data-table-id="${table.id}">${icon("plus")} 新增字段</button>
      </div>`;
    }

    const head = state.fieldMode
      ? `<div class="matrix-head is-manage"><span></span><span>字段</span><span>排序</span><span class="m-switch-head">启用</span></div>`
      : `<div class="matrix-head"><span>字段</span><span>类型</span><span>Key</span><span>标记</span><span class="m-switch-head">启用</span></div>`;

    return `${head}${table.fields.map((item) => renderMatrixRow(table, item)).join("")}`;
  }

  function renderMatrixRow(table, item) {
    const index = table.fields.findIndex((fieldItem) => fieldItem.id === item.id);
    const badges = fieldBadges(item);

    return `
      <div class="matrix-row${item.enabled ? "" : " is-off"}${state.fieldMode ? " is-manage" : ""}" data-action="edit-field" data-table-id="${table.id}" data-field-id="${item.id}" role="button" tabindex="0">
        <span class="m-drag" aria-hidden="true">${icon("grip")}</span>
        <div class="m-name">${esc(item.name)}${item.required ? '<span class="req">*</span>' : ""}</div>
        <div class="m-type">${typeLabel(item.type)}</div>
        <div class="m-key">${esc(item.key)}</div>
        <div class="m-flags">${badges || '<span class="muted">—</span>'}</div>
        <div class="m-mobile-meta">
          <span>${typeLabel(item.type)}</span><span class="muted">·</span><code>${esc(item.key)}</code>${item.ref ? `<span class="muted">·</span><span>${esc(item.ref)}</span>` : ""}
        </div>
        <div class="m-manage-order">
          <button type="button" class="row-icon-btn" data-action="move-field-up" data-table-id="${table.id}" data-field-id="${item.id}" ${index === 0 ? "disabled" : ""} aria-label="上移 ${esc(item.name)}">${icon("arrow-up")}</button>
          <button type="button" class="row-icon-btn" data-action="move-field-down" data-table-id="${table.id}" data-field-id="${item.id}" ${index === table.fields.length - 1 ? "disabled" : ""} aria-label="下移 ${esc(item.name)}">${icon("arrow-down")}</button>
        </div>
        <div class="m-switch">${renderSwitch(item.enabled, "toggle-field", `data-table-id="${table.id}" data-field-id="${item.id}"`, {
          label: `启用字段 ${item.name}`,
          sm: true,
          disabled: item.dep,
          title: item.dep ? "该字段被显示策略依赖，不能停用" : "",
        })}</div>
        ${badges ? `<div class="m-mobile-badges">${badges}</div>` : ""}
      </div>`;
  }

  /* ============================================================
   * 渲染：弹层
   * ============================================================ */

  function renderModal() {
    const modal = state.modal;
    if (!modal) return "";

    if (modal.type === "table-actions") {
      const table = getTable(modal.tableId);
      if (!table) return "";
      return renderSheet({
        kicker: "表格操作",
        title: table.name,
        sub: `${table.key} · ${table.fields.length} 字段`,
        body: `
          <div class="action-list">
            <button type="button" class="action-item" data-action="action-info" data-table-id="${table.id}">
              <span class="action-icon">${icon("edit")}</span>
              <span class="action-text"><span class="action-title">编辑表格信息</span><span class="action-desc">名称、Key、描述与表格 Prompt</span></span>
              ${icon("chevron-right")}
            </button>
            <button type="button" class="action-item" data-action="action-strategy" data-table-id="${table.id}">
              <span class="action-icon">${icon("eye")}</span>
              <span class="action-text"><span class="action-title">显示策略</span><span class="action-desc">记录在其他地方如何显示</span></span>
              ${icon("chevron-right")}
            </button>
            <div class="action-divider"></div>
            <button type="button" class="action-item action-item--danger" data-action="action-delete-table" data-table-id="${table.id}">
              <span class="action-icon">${icon("trash")}</span>
              <span class="action-text"><span class="action-title">删除表格</span><span class="action-desc">同时删除字段与记录，不可恢复</span></span>
            </button>
          </div>
          <div class="form-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="close-modal">取消</button></div>`,
      });
    }

    if (modal.type === "new-table") {
      return renderSheet({
        kicker: "新建",
        title: "新建表格",
        sub: "创建后可以在详情中新增字段、设置显示策略。",
        body: `
          <form class="form-stack" data-form="new-table">
            <div class="form-grid">
              <label class="form-row"><span class="form-label">名称 <em>*</em></span><input class="form-input" name="name" value="势力" autocomplete="off" placeholder="如：势力"></label>
              <label class="form-row"><span class="form-label">Key <em>*</em></span><input class="form-input" name="key" value="factions" autocomplete="off" placeholder="如：factions"></label>
            </div>
            <label class="form-row"><span class="form-label">描述</span><input class="form-input" name="description" value="维护组织、阵营及其目标与状态。" autocomplete="off"></label>
            <label class="form-row"><span class="form-label">表格 Prompt</span><textarea class="form-textarea" name="prompt" rows="3" placeholder="给 Agent 的填表指引（可选）"></textarea></label>
            <div class="form-hint">新表属于当前记忆空间；Key 在空间内唯一，创建后仍可修改。</div>
            <div class="form-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-action="close-modal">取消</button>
              <button type="submit" class="btn btn-primary btn-sm">创建表格</button>
            </div>
          </form>`,
      });
    }

    if (modal.type === "field") {
      const table = getTable(modal.tableId);
      if (!table) return "";
      const editing = modal.mode === "edit";
      const item = editing ? table.fields.find((fieldItem) => fieldItem.id === modal.fieldId) : null;
      if (editing && !item) return "";
      const current = item || field("", "", "short_text");
      const typeOptions = Object.entries(TYPE)
        .map(([value, meta]) => `<option value="${value}"${value === current.type ? " selected" : ""}>${meta.label}</option>`)
        .join("");
      const referenceOptions = data.tables
        .map((candidate) => `<option value="${esc(candidate.name)}"${candidate.name === current.ref ? " selected" : ""}>${esc(candidate.name)}</option>`)
        .join("");
      const isRef = current.type === "single_reference" || current.type === "multi_reference";
      const isOptions = current.type === "single_select" || current.type === "multi_select";

      return renderSheet({
        kicker: editing ? "字段定义" : "新增字段",
        title: editing ? `编辑「${current.name}」` : `在「${table.name}」中新增字段`,
        sub: editing ? "字段类型创建后不可修改。" : "字段创建后即可被记录页与 Agent 使用。",
        body: `
          <form class="form-stack" data-form="field" data-mode="${modal.mode}" data-table-id="${table.id}"${editing ? ` data-field-id="${current.id}"` : ""}>
            <div class="form-grid">
              <label class="form-row"><span class="form-label">名称 <em>*</em></span><input class="form-input" name="name" value="${esc(current.name)}" autocomplete="off" placeholder="如：所属势力"></label>
              <label class="form-row"><span class="form-label">Key <em>*</em></span><input class="form-input" name="key" value="${esc(current.key)}" autocomplete="off" placeholder="如：faction"></label>
            </div>
            <label class="form-row">
              <span class="form-label">类型 ${editing ? '<span class="form-hint">创建后不可修改</span>' : ""}</span>
              <select class="form-input" name="type" data-field-type ${editing ? "disabled" : ""}>${typeOptions}</select>
            </label>
            <label class="form-row" data-ref-row ${isRef ? "" : "hidden"}>
              <span class="form-label">引用目标表</span>
              <select class="form-input" name="ref">${referenceOptions}</select>
            </label>
            <label class="form-row" data-options-row ${isOptions ? "" : "hidden"}>
              <span class="form-label">固定选项</span>
              <textarea class="form-textarea" name="options" rows="3" placeholder="每行一个选项，如：&#10;高&#10;中&#10;低"></textarea>
            </label>
            <label class="form-row"><span class="form-label">字段 Prompt</span><textarea class="form-textarea" name="prompt" rows="3" placeholder="给 Agent 的填值指引（可选）">${esc(current.prompt || "")}</textarea></label>
            <div class="form-checks">
              <label class="form-check"><input type="checkbox" name="required" ${current.required ? "checked" : ""}><span class="check-box" aria-hidden="true"></span><span>必填</span></label>
              <label class="form-check${current.dep ? " is-disabled" : ""}"><input type="checkbox" name="enabled" ${current.enabled ? "checked" : ""} ${current.dep ? "disabled" : ""}><span class="check-box" aria-hidden="true"></span><span>启用</span></label>
            </div>
            ${current.dep ? '<div class="form-hint">该字段被显示策略依赖，不能停用或删除；请先修改显示策略。</div>' : ""}
            ${editing ? `
              <div class="form-section">
                <div class="danger-zone">
                  <div><div class="danger-title">删除字段</div><div class="danger-desc">已填写的旧值会保留，但不再显示。</div></div>
                  <button type="button" class="btn btn-danger btn-sm" data-action="confirm-delete-field" data-table-id="${table.id}" data-field-id="${current.id}" ${current.dep ? "disabled" : ""}>删除</button>
                </div>
              </div>` : ""}
            <div class="form-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-action="close-modal">取消</button>
              <button type="submit" class="btn btn-primary btn-sm" ${editing ? "" : ""}>${editing ? "保存字段" : "创建字段"}</button>
            </div>
          </form>`,
      });
    }

    if (modal.type === "info" || modal.type === "strategy") {
      const table = getTable(modal.tableId);
      if (!table) return "";
      const isInfo = modal.type === "info";
      return renderSheet({
        kicker: isInfo ? "表格信息" : "显示策略",
        title: table.name,
        sub: `${table.key} · ${table.fields.length} 字段`,
        body: isInfo
          ? renderInfoPanel(table, { scope: "modal" })
          : renderStrategyPanel(table, { scope: "modal" }),
      });
    }

    if (modal.type === "confirm-delete-table") {
      const table = getTable(modal.tableId);
      if (!table) return "";
      return renderSheet({
        kicker: "危险操作",
        title: "删除表格？",
        sub: "这个操作不可恢复。",
        body: `
          <div class="confirm-copy">确定删除 <strong>${esc(table.name)}</strong> 吗？将同时删除其中的 <strong>${table.fields.length}</strong> 个字段与全部记录。</div>
          <div class="form-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="close-modal">取消</button>
            <button type="button" class="btn btn-danger btn-sm" data-action="delete-table" data-table-id="${table.id}">删除表格</button>
          </div>`,
      });
    }

    if (modal.type === "confirm-delete-field") {
      const table = getTable(modal.tableId);
      const item = table ? table.fields.find((fieldItem) => fieldItem.id === modal.fieldId) : null;
      if (!table || !item) return "";
      return renderSheet({
        kicker: "危险操作",
        title: "删除字段？",
        sub: "已填写的旧值会保留，但不再显示。",
        body: `
          <div class="confirm-copy">确定删除 <strong>${esc(item.name)}</strong> 吗？字段 Key <span class="mono">${esc(item.key)}</span> 将不再可用。</div>
          <div class="form-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="close-modal">取消</button>
            <button type="button" class="btn btn-danger btn-sm" data-action="delete-field" data-table-id="${table.id}" data-field-id="${item.id}">删除字段</button>
          </div>`,
      });
    }

    if (modal.type === "table-picker") {
      const filtered = data.tables.filter((table) => matchesSearch(table, state.pickerSearch));
      const groups = groupTables(filtered);
      const rows = groups
        .map(
          (group) => `
            <div class="picker-group-label">${group.label}</div>
            ${group.tables
              .map(
                (table) => `
                  <button type="button" class="picker-row${table.id === state.selectedId ? " is-active" : ""}" data-action="picker-select" data-table-id="${table.id}">
                    <span class="table-glyph table-glyph--sm">${esc(initialOf(table))}</span>
                    <span class="picker-row-main">
                      <span class="picker-row-name">${esc(table.name)}</span>
                      <span class="picker-row-meta">${esc(table.key)} · ${table.fields.length} 字段 · ${enabledFieldCount(table)} 启用</span>
                    </span>
                    ${table.enabled ? "" : '<span class="badge badge--soft">停用</span>'}
                    ${table.id === state.selectedId ? `<span class="picker-check">${icon("check")}</span>` : ""}
                  </button>`
              )
              .join("")}`
        )
        .join("");
      const empty = `<div class="picker-empty">没有匹配的表格</div>`;

      return renderSheet({
        kicker: "当前表格",
        title: "切换表格",
        sub: `${data.tables.length} 张表 · 只在当前表上编辑结构`,
        body: `
          <div class="picker-search">${icon("search")}<input type="search" data-search="picker" value="${esc(state.pickerSearch)}" placeholder="搜索表格或 Key" aria-label="搜索表格"></div>
          <div class="picker-list">${filtered.length ? rows : empty}</div>
          <button type="button" class="btn btn-outline btn-sm btn-block picker-new" data-action="new-table">${icon("plus")} 新建表格</button>`,
      });
    }

    return "";
  }

  function renderSheet({ kicker, title, sub, body, confirm = false }) {
    return `
      <div class="modal-layer">
        <button type="button" class="modal-scrim" data-action="close-modal" aria-label="关闭"></button>
        <div class="sheet${confirm ? " sheet--confirm" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <div class="sheet-head">
            <div class="sheet-head-main">
              <div class="sheet-kicker">${esc(kicker)}</div>
              <div class="sheet-title">${esc(title)}</div>
              ${sub ? `<div class="sheet-sub">${esc(sub)}</div>` : ""}
            </div>
            <button type="button" class="icon-btn icon-btn--sm" data-action="close-modal" aria-label="关闭">${icon("x")}</button>
          </div>
          <div class="sheet-body">${body}</div>
        </div>
      </div>`;
  }

  /* ============================================================
   * 外壳：说明与控件
   * ============================================================ */

  const STAGE_TIPS = {
    workbench: "点左侧表格切换；点字段行编辑；「排序」显示排序按钮。",
    library: "点卡片打开检视器；卡片右下角「⋯」是表格操作；开关只控制启用。",
    focus: "点表名切换表格；点字段行编辑；「⋯」里是信息 / 策略 / 删除。",
  };

  function renderMiniMap(kind) {
    if (kind === "grid") {
      return `<div class="mini-map mini-map--grid">
        <div class="mini-block mini-block--accent">卡片</div>
        <div class="mini-block">卡片</div>
        <div class="mini-block">卡片</div>
        <div class="mini-block">卡片</div>
        <div class="mini-block">卡片</div>
        <div class="mini-block">＋ 新建</div>
      </div>`;
    }
    if (kind === "matrix") {
      return `<div class="mini-map mini-map--matrix">
        <div class="mini-block mini-block--accent">表格切换器</div>
        <div class="mini-block">字段矩阵 · 行内编辑</div>
        <div class="mini-block">表格信息 / 显示策略（弹层）</div>
      </div>`;
    }
    return `<div class="mini-map mini-map--split">
      <div class="mini-block mini-block--accent">表索引</div>
      <div class="mini-block">当前表 / 字段 / 页签</div>
    </div>`;
  }

  function renderNotes() {
    const info = CONCEPT_INFO[state.concept];
    if (!info) return;
    const notes = $("#notes");
    notes.innerHTML = `
      <div class="note-card">
        <div class="note-kicker">
          <span>方向 ${info.num}</span>
          ${info.recommend ? '<span class="note-rec">推荐</span>' : ""}
        </div>
        <div class="note-title">${info.name}</div>
        <div class="note-tagline">${info.tagline}</div>
        ${renderMiniMap(info.mini)}
        <div class="note-section">
          <div class="note-label">为什么这样</div>
          <ul class="note-list">${info.why.map((item) => `<li>${icon("check")}<span>${item}</span></li>`).join("")}</ul>
        </div>
        <div class="note-section">
          <div class="note-label">交互路径</div>
          <div class="note-path">
            ${info.path
              .map((step, index) => `${index ? icon("chevron-right") : ""}<code>${step}</code>`)
              .join("")}
          </div>
        </div>
        <div class="note-section">
          <div class="note-label">取舍</div>
          <div class="note-copy">${info.tradeoff}</div>
        </div>
        <div class="note-foot"><strong>落地提示</strong> · ${info.landing}</div>
      </div>
      <div class="note-card note-principles">
        <div class="note-kicker">共同规则</div>
        <ul class="note-list">
          ${COMMON_PRINCIPLES.map((item) => `<li>${icon("check")}<span>${item}</span></li>`).join("")}
        </ul>
      </div>
      <div class="note-card">
        <div class="note-kicker">如果让我选</div>
        <div class="note-copy" style="margin-top:8px">
          先把 <strong style="color:var(--stm-fg)">01 结构工作台</strong> 做成主线；它最直接地解决“所有表堆在一页”和按钮泛滥。<br><br>
          如果实际使用中觉得双栏太满，再退到 <strong style="color:var(--stm-fg)">02 表格库</strong>；如果只想优化字段维护效率，把 <strong style="color:var(--stm-fg)">03 的字段矩阵</strong> 嵌进 01 的右栏即可。
        </div>
      </div>`;
  }

  function syncAppearanceControls() {
    const root = document.documentElement;
    $$("[data-set-theme]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.setTheme === root.dataset.theme);
    });
    $$("[data-set-accent]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.setAccent === root.dataset.accent);
    });
    $$("[data-set-font]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.setFont === root.dataset.font);
    });
    $$("[data-set-size]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.setSize === root.dataset.size);
    });
  }

  function syncOuterControls() {
    $$(".concept-tab").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.concept === state.concept);
    });
    $$(".viewport-switch button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.viewport === state.viewport);
    });
    const tip = $("#stageTip");
    if (tip) tip.textContent = STAGE_TIPS[state.concept] || "";
    const pop = $("#appearancePop");
    if (pop) pop.hidden = !state.appearanceOpen;
    $$('[data-action="toggle-appearance"]').forEach((button) => {
      button.setAttribute("aria-expanded", String(state.appearanceOpen));
    });
    syncAppearanceControls();
  }

  function commit() {
    renderApp();
    syncOuterControls();
  }

  function commitWithNotes() {
    renderNotes();
    commit();
  }

  function showToast(message) {
    state.toast = message;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      state.toast = null;
      const toast = document.querySelector(".toast");
      if (toast) toast.remove();
    }, 2200);
  }

  function closeModal() {
    state.modal = null;
    state.pickerSearch = "";
    commit();
  }

  function resetTransient() {
    state.modal = null;
    state.search = "";
    state.pickerSearch = "";
    state.fieldMode = false;
    state.tab = "fields";
    state.mobileView = "list";
    state.inspectorOpen = false;
  }

  function openInfo(tableId) {
    state.selectedId = tableId;
    if (state.concept === "focus") {
      state.modal = { type: "info", tableId };
    } else {
      state.modal = null;
      state.tab = "info";
      state.fieldMode = false;
      if (state.concept === "library") state.inspectorOpen = true;
      if (state.concept === "workbench" && state.viewport === "mobile") {
        state.mobileView = "detail";
      }
    }
    commit();
  }

  function openStrategy(tableId) {
    state.selectedId = tableId;
    if (state.concept === "focus") {
      state.modal = { type: "strategy", tableId };
    } else {
      state.modal = null;
      state.tab = "strategy";
      state.fieldMode = false;
      if (state.concept === "library") state.inspectorOpen = true;
      if (state.concept === "workbench" && state.viewport === "mobile") {
        state.mobileView = "detail";
      }
    }
    commit();
  }

  /* ============================================================
   * 交互
   * ============================================================ */

  document.addEventListener("click", (event) => {
    /* 外观面板控制（这些按钮不走 data-action） */
    const themeButton = event.target.closest("[data-set-theme]");
    if (themeButton) {
      document.documentElement.dataset.theme = themeButton.dataset.setTheme;
      syncAppearanceControls();
      return;
    }
    const accentButton = event.target.closest("[data-set-accent]");
    if (accentButton) {
      document.documentElement.dataset.accent = accentButton.dataset.setAccent;
      syncAppearanceControls();
      return;
    }
    const fontButton = event.target.closest("[data-set-font]");
    if (fontButton) {
      document.documentElement.dataset.font = fontButton.dataset.setFont;
      syncAppearanceControls();
      return;
    }
    const sizeButton = event.target.closest("[data-set-size]");
    if (sizeButton) {
      document.documentElement.dataset.size = sizeButton.dataset.setSize;
      syncAppearanceControls();
      return;
    }

    const target = event.target.closest("[data-action]");
    if (!target) {
      if (state.appearanceOpen && !event.target.closest(".appearance-pop")) {
        state.appearanceOpen = false;
        syncOuterControls();
      }
      return;
    }

    const action = target.dataset.action;

    if (action === "set-concept") {
      state.concept = target.dataset.concept;
      resetTransient();
      commitWithNotes();
      return;
    }

    if (action === "set-viewport") {
      state.viewport = target.dataset.viewport;
      if (state.viewport === "mobile" && state.concept === "workbench") {
        state.mobileView = "list";
      }
      commit();
      return;
    }

    if (action === "toggle-appearance") {
      state.appearanceOpen = !state.appearanceOpen;
      syncOuterControls();
      return;
    }

    if (action === "reset-prototype") {
      data = { tables: createInitialData() };
      state.selectedId = "characters";
      state.tab = "fields";
      state.search = "";
      state.pickerSearch = "";
      state.modal = null;
      state.fieldMode = false;
      state.mobileView = "list";
      state.inspectorOpen = false;
      showToast("原型数据已重置");
      commit();
      return;
    }

    if (action === "select-table") {
      const table = getTable(target.dataset.tableId);
      if (!table) return;
      state.selectedId = table.id;
      state.tab = "fields";
      state.fieldMode = false;
      state.modal = null;
      if (state.concept === "workbench" && state.viewport === "mobile") {
        state.mobileView = "detail";
      }
      commit();
      return;
    }

    if (action === "open-inspector") {
      const table = getTable(target.dataset.tableId);
      if (!table) return;
      state.selectedId = table.id;
      state.tab = "fields";
      state.fieldMode = false;
      state.inspectorOpen = true;
      state.modal = null;
      commit();
      return;
    }

    if (action === "close-inspector") {
      state.inspectorOpen = false;
      commit();
      return;
    }

    if (action === "back-to-list") {
      state.mobileView = "list";
      commit();
      return;
    }

    if (action === "set-tab") {
      state.tab = target.dataset.tab;
      state.fieldMode = false;
      commit();
      return;
    }

    if (action === "toggle-field-mode") {
      state.fieldMode = !state.fieldMode;
      commit();
      return;
    }

    if (action === "toggle-table") {
      const table = getTable(target.dataset.tableId);
      if (!table) return;
      table.enabled = !table.enabled;
      showToast(`${table.name} 已${table.enabled ? "启用" : "停用"}`);
      commit();
      return;
    }

    if (action === "toggle-field") {
      const table = getTable(target.dataset.tableId);
      const item = table ? table.fields.find((fieldItem) => fieldItem.id === target.dataset.fieldId) : null;
      if (!table || !item || item.dep) return;
      item.enabled = !item.enabled;
      commit();
      return;
    }

    if (action === "move-field-up" || action === "move-field-down") {
      const table = getTable(target.dataset.tableId);
      if (!table) return;
      const index = table.fields.findIndex((fieldItem) => fieldItem.id === target.dataset.fieldId);
      const swapIndex = action === "move-field-up" ? index - 1 : index + 1;
      if (index < 0 || swapIndex < 0 || swapIndex >= table.fields.length) return;
      const fields = [...table.fields];
      [fields[index], fields[swapIndex]] = [fields[swapIndex], fields[index]];
      table.fields = fields;
      commit();
      return;
    }

    if (action === "open-table-actions") {
      const table = getTable(target.dataset.tableId);
      if (!table) return;
      state.modal = { type: "table-actions", tableId: table.id };
      commit();
      return;
    }

    if (action === "action-info") {
      openInfo(target.dataset.tableId);
      return;
    }

    if (action === "action-strategy") {
      openStrategy(target.dataset.tableId);
      return;
    }

    if (action === "action-delete-table") {
      state.modal = { type: "confirm-delete-table", tableId: target.dataset.tableId };
      commit();
      return;
    }

    if (action === "delete-table") {
      const table = getTable(target.dataset.tableId);
      if (!table) return;
      const removedName = table.name;
      data.tables = data.tables.filter((candidate) => candidate.id !== table.id);
      if (state.selectedId === table.id) {
        state.selectedId = data.tables[0] ? data.tables[0].id : null;
      }
      state.modal = null;
      state.inspectorOpen = false;
      state.mobileView = "list";
      state.tab = "fields";
      state.fieldMode = false;
      showToast(`已删除「${removedName}」`);
      commit();
      return;
    }

    if (action === "new-table") {
      state.modal = { type: "new-table" };
      commit();
      return;
    }

    if (action === "new-field") {
      const table = getTable(target.dataset.tableId || state.selectedId);
      if (!table) return;
      state.modal = { type: "field", mode: "create", tableId: table.id };
      commit();
      return;
    }

    if (action === "edit-field") {
      const table = getTable(target.dataset.tableId);
      if (!table) return;
      state.modal = {
        type: "field",
        mode: "edit",
        tableId: table.id,
        fieldId: target.dataset.fieldId,
      };
      commit();
      return;
    }

    if (action === "confirm-delete-table") {
      state.modal = { type: "confirm-delete-table", tableId: target.dataset.tableId };
      commit();
      return;
    }

    if (action === "confirm-delete-field") {
      state.modal = {
        type: "confirm-delete-field",
        tableId: target.dataset.tableId,
        fieldId: target.dataset.fieldId,
      };
      commit();
      return;
    }

    if (action === "delete-field") {
      const table = getTable(target.dataset.tableId);
      const item = table ? table.fields.find((fieldItem) => fieldItem.id === target.dataset.fieldId) : null;
      if (!table || !item || item.dep) return;
      table.fields = table.fields.filter((fieldItem) => fieldItem.id !== item.id);
      if (table.strategy.field === item.key) {
        table.strategy.field = table.fields[0] ? table.fields[0].key : "";
      }
      state.modal = null;
      showToast(`已删除字段「${item.name}」`);
      commit();
      return;
    }

    if (action === "close-modal") {
      closeModal();
      return;
    }

    if (action === "strategy-mode") {
      const table = getTable((state.modal && state.modal.tableId) || state.selectedId);
      if (!table) return;
      table.strategy.mode = target.dataset.mode;
      commit();
      return;
    }

    if (action === "insert-token") {
      const form = target.closest('form[data-form="strategy"]');
      const textarea = form ? form.querySelector("[data-strategy-template]") : null;
      if (!form || !textarea) return;
      const token = target.dataset.token || "";
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;
      textarea.value = `${textarea.value.slice(0, start)}${token}${textarea.value.slice(end)}`;
      const caret = start + token.length;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
      const table = getTable(form.dataset.tableId);
      if (table) {
        table.strategy.template = textarea.value;
        const preview = form.querySelector(".strategy-preview-text");
        if (preview) preview.textContent = strategyPreview(table);
      }
      return;
    }

    if (action === "open-table-picker") {
      state.modal = { type: "table-picker" };
      state.pickerSearch = "";
      commit();
      return;
    }

    if (action === "picker-select") {
      const table = getTable(target.dataset.tableId);
      if (!table) return;
      state.selectedId = table.id;
      state.tab = "fields";
      state.fieldMode = false;
      state.modal = null;
      state.pickerSearch = "";
      commit();
      return;
    }

    if (action === "nav-hint") {
      showToast("抽屉导航由面板骨架负责，这里专注表格页");
      commit();
      return;
    }

    if (action === "close-hint") {
      showToast("关闭面板（原型只演示表格页）");
      commit();
      return;
    }
  });

  /* ---------- 输入 ---------- */
  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    if (target.matches("[data-search]")) {
      if (event.isComposing) return;
      const kind = target.dataset.search;
      if (kind === "picker") {
        state.pickerSearch = target.value;
        state.focusTarget = "picker";
      } else {
        state.search = target.value;
        state.focusTarget = "tables";
      }
      renderApp();
      return;
    }

    if (target.matches("[data-strategy-template]")) {
      const form = target.closest('form[data-form="strategy"]');
      const table = form ? getTable(form.dataset.tableId) : null;
      if (!form || !table) return;
      table.strategy.template = target.value;
      const preview = form.querySelector(".strategy-preview-text");
      if (preview) preview.textContent = strategyPreview(table);
    }
  });

  /* ---------- 选择 ---------- */
  document.addEventListener("change", (event) => {
    const typeSelect = event.target.closest("[data-field-type]");
    if (typeSelect) {
      const form = typeSelect.closest("form");
      const type = typeSelect.value;
      const refRow = form.querySelector("[data-ref-row]");
      const optionsRow = form.querySelector("[data-options-row]");
      if (refRow) {
        refRow.hidden = !(type === "single_reference" || type === "multi_reference");
      }
      if (optionsRow) {
        optionsRow.hidden = !(type === "single_select" || type === "multi_select");
      }
      return;
    }

    const strategyField = event.target.closest("[data-strategy-field]");
    if (strategyField) {
      const form = strategyField.closest("form");
      const table = form ? getTable(form.dataset.tableId) : null;
      if (!form || !table) return;
      table.strategy.field = strategyField.value;
      const preview = form.querySelector(".strategy-preview-text");
      if (preview) preview.textContent = strategyPreview(table);
    }
  });

  /* ---------- 提交 ---------- */
  document.addEventListener("submit", (event) => {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    const fd = new FormData(form);
    const formKind = form.dataset.form;
    const table = getTable(form.dataset.tableId);
    if (!table) return;

    if (formKind === "info") {
      const name = String(fd.get("name") || "").trim();
      const key = String(fd.get("key") || "").trim();
      if (!name || !key) {
        showToast("名称和 Key 不能为空");
        commit();
        return;
      }
      if (data.tables.some((candidate) => candidate.id !== table.id && candidate.key === key)) {
        showToast("这个 Key 已经被占用");
        commit();
        return;
      }
      table.name = name;
      table.key = key;
      table.description = String(fd.get("description") || "").trim();
      table.prompt = String(fd.get("prompt") || "");
      if (form.dataset.scope === "modal") state.modal = null;
      showToast("表格信息已保存");
      commit();
      return;
    }

    if (formKind === "strategy") {
      if (table.strategy.mode === "field") {
        table.strategy.field = String(fd.get("field") || "");
      } else {
        table.strategy.template = String(fd.get("template") || "");
      }
      if (form.dataset.scope === "modal") state.modal = null;
      showToast("显示策略已保存");
      commit();
      return;
    }

    if (formKind === "new-table") {
      const name = String(fd.get("name") || "").trim();
      const key = String(fd.get("key") || "").trim();
      if (!name || !key) {
        showToast("名称和 Key 不能为空");
        commit();
        return;
      }
      if (data.tables.some((candidate) => candidate.key === key)) {
        showToast("这个 Key 已经被占用");
        commit();
        return;
      }
      const newTable = {
        id: `custom_${Date.now()}`,
        name,
        key,
        system: false,
        enabled: true,
        description: String(fd.get("description") || "").trim(),
        prompt: String(fd.get("prompt") || ""),
        strategy: { mode: "field", field: "", template: "" },
        fields: [],
      };
      data.tables.push(newTable);
      state.selectedId = newTable.id;
      state.tab = "fields";
      state.fieldMode = false;
      state.modal = null;
      state.search = "";
      state.pickerSearch = "";
      state.inspectorOpen = state.concept === "library";
      if (state.concept === "workbench" && state.viewport === "mobile") {
        state.mobileView = "detail";
      }
      showToast(`已创建「${name}」`);
      commit();
      return;
    }

    if (formKind === "field") {
      const name = String(fd.get("name") || "").trim();
      const key = String(fd.get("key") || "").trim();
      if (!name || !key) {
        showToast("名称和 Key 不能为空");
        commit();
        return;
      }
      const mode = form.dataset.mode;
      const editing = mode === "edit";
      const current = editing
        ? table.fields.find((fieldItem) => fieldItem.id === form.dataset.fieldId)
        : null;
      if (editing && !current) return;
      if (table.fields.some((fieldItem) => fieldItem.id !== current?.id && fieldItem.key === key)) {
        showToast("字段 Key 在这个表里已存在");
        commit();
        return;
      }
      const type = editing
        ? current.type
        : String(fd.get("type") || "short_text");
      const required = fd.get("required") === "on";
      const dep = current ? current.dep : false;
      const enabled = dep ? true : fd.get("enabled") === "on";
      const ref =
        type === "single_reference" || type === "multi_reference"
          ? String(fd.get("ref") || "") || null
          : null;
      const prompt = String(fd.get("prompt") || "");

      if (editing && current) {
        const previousKey = current.key;
        current.name = name;
        current.key = key;
        current.required = required;
        current.enabled = enabled;
        current.ref = ref;
        current.prompt = prompt;
        if (table.strategy.field === previousKey) {
          table.strategy.field = key;
        }
      } else {
        table.fields.push({
          id: `field_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name,
          key,
          type,
          required,
          enabled,
          ref,
          dep: false,
          prompt,
        });
        if (!table.strategy.field) {
          table.strategy.field = key;
        }
      }
      state.modal = null;
      showToast(editing ? "字段已保存" : "字段已创建");
      commit();
    }
  });

  /* ---------- 键盘 ---------- */
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (state.modal) {
        closeModal();
        return;
      }
      if (state.inspectorOpen) {
        state.inspectorOpen = false;
        commit();
        return;
      }
      if (state.appearanceOpen) {
        state.appearanceOpen = false;
        syncOuterControls();
      }
      return;
    }

    if (
      (event.key === "Enter" || event.key === " ") &&
      event.target.matches('[role="button"][data-action]')
    ) {
      event.preventDefault();
      event.target.click();
    }
  });

  /* ---------- 启动 ---------- */
  (() => {
    const raw = location.hash.replace(/^#/, "");
    if (!raw) return;
    const parts = raw.split(/[-/]/);
    if (["workbench", "library", "focus"].includes(parts[0])) state.concept = parts[0];
    if (parts.includes("desktop")) state.viewport = "desktop";
    if (parts.includes("mobile")) state.viewport = "mobile";
    if (parts.includes("detail")) state.mobileView = "detail";
    if (parts.includes("inspector")) state.inspectorOpen = true;
    if (parts.includes("fieldmode")) state.fieldMode = true;
    if (parts.includes("actions")) state.modal = { type: "table-actions", tableId: state.selectedId };
    if (parts.includes("picker")) state.modal = { type: "table-picker" };
    if (parts.includes("newtable")) state.modal = { type: "new-table" };
  })();

  renderNotes();
  commit();
})();
