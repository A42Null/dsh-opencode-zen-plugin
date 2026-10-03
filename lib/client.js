/**
 * opencode-zen · 客户端半部（Web GUI 设置卡片）
 *
 * DSH 的设置界面完全由插件的客户端半部贡献：本文件注册到
 * `plugins.row.config`（key = `<包名>#<行 id>`），使「设置 → 插件」中
 * opencode-zen 这一行出现「配置」入口，并在页面里渲染表单。
 *
 * 宿主通过 ownerProps 提供 `{ view, form }`：
 *   view = 'summary' | 'page'
 *   form = ConfigPageForm：
 *     form.state → { status, value, base, revision, writable }
 *     form.mutate([{ op: 'set' | 'unset', path: [...], value? }], revision) → Promise<boolean>
 *
 * Config 中的 volatile 节点是 `console`，因此写入路径为 ['console', <字段>]。
 */
window.__ModuleLoader__.load({
  id: "@A42Null/dsh-opencode-zen-plugin",
  factory: (require) => {
    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const NS = "opencode-zen";
    const NODE = "console";
    const DEFAULTS = {
      baseUrl: "https://opencode.ai/zen",
      includeFreeModels: false,
      refreshSeconds: 300,
    };

    const h = React.createElement;

    const LABELS = {
      unavailable: "设置服务不可用，无法读写 opencode-zen 配置。",
      readOnly: "当前配置为只读。",
      saveFailed: "保存失败，请重试。",
      save: "保存",
      saving: "保存中…",
    };

    const S = {
      body: { display: "flex", flexDirection: "column", gap: "12px" },
      field: { display: "flex", flexDirection: "column", gap: "4px" },
      label: { fontSize: "13px", fontWeight: 500, color: "var(--dsw-alias-label-primary, #1f2329)" },
      hint: { fontSize: "12px", lineHeight: 1.45, color: "var(--dsw-alias-label-tertiary, #6b7280)", margin: 0 },
      input: {
        boxSizing: "border-box",
        width: "100%",
        padding: "6px 8px",
        fontSize: "13px",
        borderRadius: "6px",
        border: "1px solid var(--dsw-alias-border-l2, #d0d7de)",
        background: "var(--dsw-alias-bg-layer-2, #f6f8fa)",
        color: "var(--dsw-alias-label-primary, #1f2329)",
        colorScheme: "light",
      },
      checkboxRow: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" },
      ok: { fontSize: "12px", color: "var(--dsw-alias-state-success-primary, #1a7f37)", margin: 0 },
      error: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #d1242f)", margin: 0 },
    };

    /** 「未编辑」用 null 表示：显示已保存值，且不产生写入。 */
    function fieldValue(edited, served, fallback) {
      if (edited !== null && edited !== undefined) return edited;
      if (served !== null && served !== undefined) return served;
      return fallback;
    }

    function Card(props) {
      const view = props.view;
      const form = props.form;
      const snapshot = form && form.state ? form.state : undefined;
      const served = (snapshot && snapshot.value && snapshot.value[NODE]) || {};
      const base = Object.assign({}, DEFAULTS, (snapshot && snapshot.base && snapshot.base[NODE]) || {});
      const ready = !!snapshot && snapshot.status === "ready";
      const writable = ready && snapshot.writable !== false && !!form;

      const [apiKey, setApiKey] = React.useState("");
      const [baseUrl, setBaseUrl] = React.useState(null);
      const [includeFree, setIncludeFree] = React.useState(null);
      const [refreshSeconds, setRefreshSeconds] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [saved, setSaved] = React.useState(false);
      const [failed, setFailed] = React.useState(false);

      if (view === "summary") {
        return h("span", null, "填入 OpenCode Console API Key，即可在 DSH 中使用全部 OpenCode Zen 模型。");
      }

      const effective = {
        baseUrl: fieldValue(baseUrl, served.baseUrl, DEFAULTS.baseUrl),
        includeFreeModels: fieldValue(includeFree, served.includeFreeModels, DEFAULTS.includeFreeModels),
        refreshSeconds: fieldValue(refreshSeconds, served.refreshSeconds, DEFAULTS.refreshSeconds),
      };

      /** 与已保存值相同 → 不写；等于默认值 → unset（回到继承值）；否则 set。 */
      const ops = [];
      /** 未在配置中出现的字段，其"当前值"就是默认值，避免无改动也产生写入。 */
      const current = (field) =>
        served[field] !== undefined && served[field] !== null ? served[field] : base[field];
      const push = (field, next, fallback) => {
        const before = current(field);
        if (JSON.stringify(next) === JSON.stringify(before)) return;
        if (JSON.stringify(next) === JSON.stringify(fallback)) {
          ops.push({ op: "unset", path: [NODE, field] });
        } else {
          ops.push({ op: "set", path: [NODE, field], value: next });
        }
      };
      push("baseUrl", String(effective.baseUrl).trim(), base.baseUrl);
      push("includeFreeModels", effective.includeFreeModels === true, base.includeFreeModels);
      push("refreshSeconds", Number(effective.refreshSeconds), base.refreshSeconds);

      const key = apiKey.trim();
      const dirty = key.length > 0 || ops.length > 0;
      const invalid =
        String(effective.baseUrl).trim().length === 0 ||
        !Number.isFinite(Number(effective.refreshSeconds)) ||
        Number(effective.refreshSeconds) < 30 ||
        Number(effective.refreshSeconds) > 86400;

      const handleSave = async () => {
        if (!writable || invalid) {
          setSaved(false);
          setFailed(true);
          return;
        }
        const writes = key.length > 0 ? ops.concat([{ op: "set", path: [NODE, "apiKey"], value: key }]) : ops;
        if (writes.length === 0) {
          setSaved(true);
          setFailed(false);
          return;
        }
        setSaving(true);
        setSaved(false);
        setFailed(false);
        try {
          const ok = await form.mutate(writes, snapshot.revision);
          if (ok) {
            setSaved(true);
            setApiKey("");
            setBaseUrl(null);
            setIncludeFree(null);
            setRefreshSeconds(null);
          } else {
            setFailed(true);
          }
        } catch {
          setFailed(true);
        } finally {
          setSaving(false);
        }
      };

      const handleDiscard = () => {
        setApiKey("");
        setBaseUrl(null);
        setIncludeFree(null);
        setRefreshSeconds(null);
        setSaved(false);
        setFailed(false);
      };

      const children = [
        h(
          "label",
          { key: "apiKey", style: S.field },
          h("span", { style: S.label }, "API Key"),
          h("input", {
            style: S.input,
            type: "password",
            autoComplete: "off",
            spellCheck: false,
            placeholder: served.apiKey ? "已保存（留空则不修改）" : "粘贴 OpenCode Console API Key",
            value: apiKey,
            disabled: !writable,
            onChange: (event) => setApiKey(event.target.value),
          }),
          h("span", { style: S.hint }, "在 https://opencode.ai/console 登录后获取；保存后立即生效，无需重启 DSH。"),
        ),
        h(
          "label",
          { key: "baseUrl", style: S.field },
          h("span", { style: S.label }, "网关地址"),
          h("input", {
            style: S.input,
            type: "text",
            spellCheck: false,
            value: String(effective.baseUrl),
            disabled: !writable,
            onChange: (event) => setBaseUrl(event.target.value),
          }),
          h("span", { style: S.hint }, "默认 https://opencode.ai/zen，通常无需修改。"),
        ),
        h(
          "label",
          { key: "includeFreeModels", style: S.checkboxRow },
          h("input", {
            type: "checkbox",
            checked: effective.includeFreeModels === true,
            disabled: !writable,
            onChange: (event) => setIncludeFree(event.target.checked),
          }),
          h("span", null, "在模型列表中包含免费模型（*-free，只能在 OpenCode 客户端内使用，经 API 调用会失败）"),
        ),
        h(
          "label",
          { key: "refreshSeconds", style: S.field },
          h("span", { style: S.label }, "模型目录刷新间隔（秒）"),
          h("input", {
            style: S.input,
            type: "number",
            min: 30,
            max: 86400,
            value: String(effective.refreshSeconds),
            disabled: !writable,
            onChange: (event) => setRefreshSeconds(event.target.value === "" ? "" : Number(event.target.value)),
          }),
          h("span", { style: S.hint }, "取值 30–86400，默认 300 秒。"),
        ),
      ];
      if (saved) children.push(h("p", { key: "saved", style: S.ok }, "已保存"));
      if (failed) children.push(h("p", { key: "failed", style: S.error }, invalid ? "请检查网关地址与刷新间隔（30–86400 秒）。" : LABELS.saveFailed));

      return h(
        primitives.SettingsForm,
        {
          labels: LABELS,
          state: {
            available: ready && !!form,
            writable: writable,
            dirty: dirty,
            invalid: invalid,
            saving: saving,
            failed: failed,
          },
          onSave: () => {
            void handleSave();
          },
          onDiscard: handleDiscard,
        },
        h("div", { style: S.body }, children),
      );
    }

    const inject = ["slots"];

    function apply(ctx) {
      const slots = ctx.slots;
      if (!slots || typeof slots.register !== "function") return;
      ctx.inject(["configForms"], (formCtx) => {
        formCtx.effect(
          () =>
            formCtx.configForms.whileServed([NS], () => {
              const disposers = ["@A42Null/dsh-opencode-zen-plugin", NS].map((pkg) =>
                slots.register({ name: "plugins.row.config", key: pkg + "#" + NS }, Card),
              );
              let legacy = () => {};
              const hasRowSlot = typeof slots.spec === "function" && slots.spec("plugins.row.config") !== undefined;
              if (!hasRowSlot) {
                legacy = slots.register({ name: "plugins.item", id: NS, order: 30, label: "OpenCode Zen" }, Card);
              }
              return () => {
                for (const dispose of disposers) dispose();
                if (typeof legacy === "function") legacy();
              };
            }),
          "opencode-zen: settings page",
        );
      });
    }

    return { NS, apply, inject };
  },
});
