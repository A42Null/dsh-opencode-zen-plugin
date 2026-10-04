/**
 * dsh-opencode-zen-plugin · 客户端半部（Web GUI 设置卡片）
 *
 * DSH 的设置界面完全由插件的客户端半部贡献：本文件注册到
 * `plugins.row.config`（key = `<包名>#<行 id>`），使「设置 → 插件」中
 * opencode-zen 这一行出现「配置」入口，并在页面里渲染表单。
 *
 * 宿主通过 ownerProps 提供 `{ view, form, t }`：
 *   view = 'summary' | 'page'
 *   form = ConfigPageForm：
 *     form.state → { status, value, base, revision, writable }
 *     form.mutate([{ op: 'set' | 'unset', path: [...], value? }], revision) → Promise<boolean>
 *   t = 注册时声明 locale 命名空间后由宿主注入的翻译函数
 *
 * 文案：DSH 浏览器端内置 locale 为 `zh` 与 `en`，两种字典都要注册；
 * 若 locale 服务不可用（或当前语言缺词条），回落英文。
 *
 * Config 中的 volatile 节点是 `console`，因此写入路径为 ['console', <字段>]。
 */
window.__ModuleLoader__.load({
  // 必须等于本包在 package.json 里的 name：DSH 以「行名」为工厂注册键，
  // 声明成别的名字会导致 duplicate factory registration / import failed（曾因改名漏改而挂掉整个页面）。
  id: "@a42null/dsh-opencode-zen-plugin",
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

    /** 简体中文文案 */
    const zh = {
      summary: "填入 OpenCode Console API Key，即可在 DSH 中使用 OpenCode Zen 模型。",
      title: "OpenCode Zen",
      apiKey: "API Key",
      apiKeyPlaceholder: "粘贴 OpenCode Console API Key",
      apiKeySavedPlaceholder: "已保存（留空则不修改）",
      apiKeyHint: "在 https://opencode.ai/console 登录后获取；保存后立即生效，无需重启 DSH。",
      baseUrl: "网关地址",
      baseUrlHint: "默认 https://opencode.ai/zen，通常无需修改。",
      includeFree: "在模型列表中包含免费模型（*-free，只能在 OpenCode 客户端内使用，经 API 调用会失败）",
      refreshSeconds: "模型目录刷新间隔（秒）",
      refreshSecondsHint: "取值 30–86400，默认 300 秒。",
      saved: "已保存",
      invalid: "请检查网关地址与刷新间隔（30–86400 秒）。",
      unavailable: "设置服务不可用，无法读写 opencode-zen 配置。",
      readOnly: "当前配置为只读。",
      saveFailed: "保存失败，请重试。",
      save: "保存",
      saving: "保存中…",
    };

    /** English copy — also the fallback for any other active locale. */
    const en = {
      summary: "Paste an OpenCode Console API key here and the Console's chat models become selectable in DSH.",
      title: "OpenCode Zen",
      apiKey: "API key",
      apiKeyPlaceholder: "Paste your OpenCode Console API key",
      apiKeySavedPlaceholder: "Saved (leave empty to keep it)",
      apiKeyHint: "Get one at https://opencode.ai/console. It takes effect immediately after saving — no DSH restart needed.",
      baseUrl: "Gateway URL",
      baseUrlHint: "Defaults to https://opencode.ai/zen and rarely needs changing.",
      includeFree: "Include free models (*-free). They only run inside the OpenCode client, so API calls fail",
      refreshSeconds: "Catalog refresh interval (seconds)",
      refreshSecondsHint: "30–86400; defaults to 300.",
      saved: "Saved",
      invalid: "Check the gateway URL and the refresh interval (30–86400 seconds).",
      unavailable: "The settings service is unavailable, so the opencode-zen configuration cannot be read or written.",
      readOnly: "This configuration is read-only.",
      saveFailed: "Saving failed, please try again.",
      save: "Save",
      saving: "Saving…",
    };

    /** 与 DSH 的回落链一致：最终落到英文。 */
    const FALLBACK = en;

    /** apply() 里绑定的当前语言翻译器；外壳未注入 props.t 时用它兜底。 */
    let boundT;

    /** 先问宿主的 t()，拿不到（或只有 key 本身）时用本地英文兜底。 */
    function text(t, key) {
      if (typeof t === "function") {
        const value = t(key);
        if (typeof value === "string" && value.length > 0 && value !== key) return value;
      }
      return FALLBACK[key] || key;
    }

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
      const t = (key) => text(props.t !== undefined ? props.t : boundT, key);
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
        return h("span", null, t("summary"));
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
          h("span", { style: S.label }, t("apiKey")),
          h("input", {
            style: S.input,
            type: "password",
            autoComplete: "off",
            spellCheck: false,
            placeholder: served.apiKey ? t("apiKeySavedPlaceholder") : t("apiKeyPlaceholder"),
            value: apiKey,
            disabled: !writable,
            onChange: (event) => setApiKey(event.target.value),
          }),
          h("span", { style: S.hint }, t("apiKeyHint")),
        ),
        h(
          "label",
          { key: "baseUrl", style: S.field },
          h("span", { style: S.label }, t("baseUrl")),
          h("input", {
            style: S.input,
            type: "text",
            spellCheck: false,
            value: String(effective.baseUrl),
            disabled: !writable,
            onChange: (event) => setBaseUrl(event.target.value),
          }),
          h("span", { style: S.hint }, t("baseUrlHint")),
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
          h("span", null, t("includeFree")),
        ),
        h(
          "label",
          { key: "refreshSeconds", style: S.field },
          h("span", { style: S.label }, t("refreshSeconds")),
          h("input", {
            style: S.input,
            type: "number",
            min: 30,
            max: 86400,
            value: String(effective.refreshSeconds),
            disabled: !writable,
            onChange: (event) => setRefreshSeconds(event.target.value === "" ? "" : Number(event.target.value)),
          }),
          h("span", { style: S.hint }, t("refreshSecondsHint")),
        ),
      ];
      if (saved) children.push(h("p", { key: "saved", style: S.ok }, t("saved")));
      if (failed) children.push(h("p", { key: "failed", style: S.error }, invalid ? t("invalid") : t("saveFailed")));

      return h(
        primitives.SettingsForm,
        {
          labels: {
            unavailable: t("unavailable"),
            readOnly: t("readOnly"),
            saveFailed: t("saveFailed"),
            save: t("save"),
            saving: t("saving"),
          },
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

    const inject = ["slots", "locale"];

    function apply(ctx) {
      const slots = ctx.slots;
      if (!slots || typeof slots.register !== "function") return;

      // locale 必须硬注入：用可选的 ctx.get("locale") 在真实运行时拿不到服务，字典就不会注册，
      // 于是 t() 取不到译文而回落到英文（曾出现中英混杂）。这里照 DSH 官方插件的写法注册。
      boundT = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "opencode-zen: copy dictionaries");

      ctx.inject(["configForms"], (formCtx) => {
        formCtx.effect(
          () =>
            formCtx.configForms.whileServed([NS], () => {
              // 同时覆盖无作用域名与 GitHub Packages 的带作用域名（@a42null/...）两种安装形态
              const disposers = ["dsh-opencode-zen-plugin", "@a42null/dsh-opencode-zen-plugin", NS].map((pkg) =>
                slots.register({ name: "plugins.row.config", key: pkg + "#" + NS, locale: NS }, Card),
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
