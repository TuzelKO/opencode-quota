import { createMemo, createSignal, For, Show } from "solid-js"
import type { MountedSession, PanelTab, SessionScreen } from "@opencode/plugin/gui"
import { createKeyed, MenuItem, Panel, Plugin, Slot, Style } from "@opencode/plugin/gui"
import { Quota } from "./rpc"

type Window = {
  id: string
  percent: number
  resetsAt?: number
  used?: number
  limit?: number
  unit?: string
  limited?: boolean
}

type Report = {
  providerID: string
  plan?: string
  windows: Window[]
  error?: string
  fetchedAt: number
}

const GO = "opencode-go"

const KNOWN = [
  "opencode-go",
  "zai-coding-plan",
  "zhipuai-coding-plan",
  "kimi-code-plan-global",
  "kimi-code-plan-cn",
] as const

const REMOTE = [
  "zai-coding-plan",
  "zhipuai-coding-plan",
  "kimi-code-plan-global",
  "kimi-code-plan-cn",
] as const

const FALLBACK: Record<string, string> = {
  "opencode-go": "OpenCode Go",
  "zai-coding-plan": "Z.AI Coding Plan",
  "zhipuai-coding-plan": "Zhipu AI Coding Plan",
  "kimi-code-plan-global": "Kimi Code",
  "kimi-code-plan-cn": "Kimi Code (CN)",
}

const WINDOW_ORDER = ["5h", "week", "month"]

const WINDOW_KEY: Record<string, string> = {
  "5h": "window.5h",
  week: "window.week",
  month: "window.month",
}

const css = `
.q-chip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border: 1px solid var(--v2-border-border-muted); border-radius: 999px; background: transparent; color: var(--v2-text-text-muted); font: inherit; font-size: 11px; font-variant-numeric: tabular-nums; cursor: pointer; }
.q-chip:hover { background: var(--v2-overlay-simple-overlay-hover); color: var(--v2-text-text-base); }
.q-chip[data-tone="warning"] { color: var(--v2-orange-600); }
.q-chip[data-tone="danger"] { color: var(--v2-red-600); }
.q-ring { flex: none; display: block; }
.q-ring-spin { animation: q-spin .9s linear infinite; transform-origin: center; }
@keyframes q-spin { to { transform: rotate(360deg); } }
.q-panel { box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; height: 100%; padding: 14px 14px 6px; overflow-y: auto; color: var(--v2-text-text-base); font-size: 13px; line-height: var(--line-height-compact, 1.4); }
.q-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--v2-text-text-muted); font-size: 11px; }
.q-item { flex: none; border: 1px solid var(--v2-border-border-muted); border-radius: 8px; overflow: hidden; background: var(--v2-background-bg-layer-01); }
.q-item[data-open="true"] { background: var(--v2-background-bg-layer-02); }
.q-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.q-head:hover { background: var(--v2-overlay-simple-overlay-hover); }
.q-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 530; }
.q-pct { flex: none; color: var(--v2-text-text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.q-body { display: flex; flex-direction: column; gap: 0; padding: 6px 12px 4px; }
.q-window { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; }
.q-window + .q-window { border-top: 1px solid var(--v2-border-border-muted); }
.q-window:last-child { padding-bottom: 2px; }
.q-window-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.q-window-name { font-weight: 500; }
.q-window-pct { color: var(--v2-text-text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.q-bar { height: 4px; border-radius: 999px; background: var(--v2-overlay-simple-overlay-hover); overflow: hidden; }
.q-bar-fill { height: 100%; border-radius: inherit; }
.q-window-foot { display: flex; justify-content: space-between; gap: 8px; margin-top: 2px; color: var(--v2-text-text-weak); font-size: 11px; font-variant-numeric: tabular-nums; }
.q-muted { color: var(--v2-text-text-muted); }
.q-error { color: var(--v2-state-fg-danger); font-size: 11px; }
.q-empty { color: var(--v2-text-text-muted); font-size: 12px; }
`

const clamp = (value: number) => Math.max(0, Math.min(100, value))

type Tone = "normal" | "warning" | "danger"

const WARN_AT = 70
const DANGER_AT = 90

const toneOf = (percent?: number): Tone =>
  percent === undefined ? "normal" : percent >= DANGER_AT ? "danger" : percent >= WARN_AT ? "warning" : "normal"

const toneColor = (percent?: number): string | undefined => {
  const tone = toneOf(percent)
  if (tone === "danger") return "var(--v2-red-600)"
  if (tone === "warning") return "var(--v2-orange-600)"
  return undefined
}

const trackColor = (percent?: number): string | undefined => {
  const color = toneColor(percent)
  return color ? `color-mix(in srgb, ${color} 22%, transparent)` : undefined
}

const Ring = (props: { percent?: number; size?: number; loading?: boolean }) => {
  const size = () => props.size ?? 14
  const radius = () => size() / 2 - 1.5
  const length = () => 2 * Math.PI * radius()
  const value = () => clamp(props.percent ?? 0)
  const color = () => (props.loading ? "currentColor" : toneColor(props.percent) ?? "currentColor")
  const offset = () => (props.loading ? length() * 0.72 : length() * (1 - value() / 100))

  return (
    <svg
      class="q-ring"
      classList={{ "q-ring-spin": props.loading === true }}
      width={size()}
      height={size()}
      viewBox={`0 0 ${size()} ${size()}`}
      aria-hidden="true"
      style={{ color: color() }}
    >
      <circle cx={size() / 2} cy={size() / 2} r={radius()} fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="2" />
      <circle
        cx={size() / 2}
        cy={size() / 2}
        r={radius()}
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-dasharray={`${length()}`}
        stroke-dashoffset={`${offset()}`}
        transform={`rotate(-90 ${size() / 2} ${size() / 2})`}
      />
    </svg>
  )
}

export default Plugin.define({
  i18n: {
    en: {
      "tab.title": "Quota",
      "menu.title": "Provider quota",
      "ring.title": "{{provider}} · {{percent}}% used · resets in {{time}}",
      "ring.none": "No quota data for this provider",
      "window.5h": "5 hours",
      "window.week": "Week",
      "window.month": "Month",
      "window.used": "{{used}} of {{limit}}",
      "left.days": "{{days}}d {{hours}}h",
      "left.hours": "{{hours}}h {{minutes}}m",
      "left.minutes": "{{minutes}}m",
      "left.now": "now",
      "refresh": "Refresh",
      "refreshing": "Refreshing…",
      "updated.now": "Updated just now",
      "updated.ago": "Updated {{time}} ago",
      "error": "Unavailable: {{message}}",
      "error.noCredential": "No credential for this provider",
      "empty": "No windows reported",
    },
    ru: {
      "tab.title": "Лимиты",
      "menu.title": "Лимиты провайдера",
      "ring.title": "{{provider}} · использовано {{percent}}% · сброс через {{time}}",
      "ring.none": "Нет данных о лимитах этого провайдера",
      "window.5h": "5 часов",
      "window.week": "Неделя",
      "window.month": "Месяц",
      "window.used": "{{used}} из {{limit}}",
      "left.days": "{{days}} д {{hours}} ч",
      "left.hours": "{{hours}} ч {{minutes}} мин",
      "left.minutes": "{{minutes}} мин",
      "left.now": "сейчас",
      "refresh": "Обновить",
      "refreshing": "Обновляю…",
      "updated.now": "Обновлено только что",
      "updated.ago": "Обновлено {{time}} назад",
      "error": "Недоступно: {{message}}",
      "error.noCredential": "У провайдера нет ключа",
      "empty": "Провайдер не вернул ни одного окна",
    },
    de: {
      "tab.title": "Kontingent",
      "menu.title": "Anbieter-Kontingent",
      "ring.title": "{{provider}} · {{percent}}% verbraucht · Zurücksetzung in {{time}}",
      "ring.none": "Keine Kontingentdaten für diesen Anbieter",
      "window.5h": "5 Stunden",
      "window.week": "Woche",
      "window.month": "Monat",
      "window.used": "{{used}} von {{limit}}",
      "left.days": "{{days}} T {{hours}} Std.",
      "left.hours": "{{hours}} Std. {{minutes}} Min.",
      "left.minutes": "{{minutes}} Min.",
      "left.now": "jetzt",
      "refresh": "Aktualisieren",
      "refreshing": "Wird aktualisiert…",
      "updated.now": "Gerade aktualisiert",
      "updated.ago": "Vor {{time}} aktualisiert",
      "error": "Nicht verfügbar: {{message}}",
      "error.noCredential": "Kein Schlüssel für diesen Anbieter",
      "empty": "Keine Fenster gemeldet",
    },
    fr: {
      "tab.title": "Quota",
      "menu.title": "Quota du fournisseur",
      "ring.title": "{{provider}} · {{percent}} % utilisé · réinitialisation dans {{time}}",
      "ring.none": "Aucune donnée de quota pour ce fournisseur",
      "window.5h": "5 heures",
      "window.week": "Semaine",
      "window.month": "Mois",
      "window.used": "{{used}} sur {{limit}}",
      "left.days": "{{days}} j {{hours}} h",
      "left.hours": "{{hours}} h {{minutes}} min",
      "left.minutes": "{{minutes}} min",
      "left.now": "maintenant",
      "refresh": "Actualiser",
      "refreshing": "Actualisation…",
      "updated.now": "À l'instant",
      "updated.ago": "Mis à jour il y a {{time}}",
      "error": "Indisponible : {{message}}",
      "error.noCredential": "Aucune clé pour ce fournisseur",
      "empty": "Aucune fenêtre signalée",
    },
    zh: {
      "tab.title": "配额",
      "menu.title": "服务商配额",
      "ring.title": "{{provider}} · 已用 {{percent}}% · {{time}} 后重置",
      "ring.none": "该服务商没有配额数据",
      "window.5h": "5 小时",
      "window.week": "每周",
      "window.month": "每月",
      "window.used": "{{used}} / {{limit}}",
      "left.days": "{{days}} 天 {{hours}} 小时",
      "left.hours": "{{hours}} 小时 {{minutes}} 分钟",
      "left.minutes": "{{minutes}} 分钟",
      "left.now": "现在",
      "refresh": "刷新",
      "refreshing": "正在刷新…",
      "updated.now": "刚刚更新",
      "updated.ago": "{{time}} 前更新",
      "error": "不可用：{{message}}",
      "error.noCredential": "该服务商没有密钥",
      "empty": "服务商未返回任何窗口",
    },
  },
  setup(ctx) {
    const ui = ctx.ui
    const [reports, setReports] = createSignal<Record<string, Report>>({})
    const [pending, setPending] = createSignal<Record<string, boolean>>({})
    const [now, setNow] = createSignal(Date.now())

    const pendingFor = (providerID: string) => pending()[providerID] === true
    const refreshing = () => REMOTE.some(pendingFor)

    const loadSource = async (providerID: string, force: boolean) => {
      if (pendingFor(providerID)) return
      setPending((prev) => ({ ...prev, [providerID]: true }))
      try {
        const result = (await ctx.client.rpc(Quota).usage({ providerID, force })) as { providers: Report[] }
        const report = result.providers.find((item) => item.providerID === providerID)
        if (report) setReports((prev) => ({ ...prev, [providerID]: report }))
      } catch {
        // The server part may not be loaded yet; the next tick retries.
      } finally {
        setPending((prev) => ({ ...prev, [providerID]: false }))
      }
    }

    const load = (force = false) => {
      for (const providerID of REMOTE) void loadSource(providerID, force)
      const session = ctx.sessions.current()
      const location = session?.location
      if (location) void session.server.data.location.usage.sync(location).catch(() => {})
    }

    void load()
    const timer = setInterval(() => load(), 300_000)
    const tick = setInterval(() => setNow(Date.now()), 30_000)

    const synced = new Set<string>()

    const ensure = (session: MountedSession) => {
      const location = session.location
      if (!location || synced.has(location.directory)) return
      synced.add(location.directory)
      void Promise.all([
        session.server.data.location.usage.sync(location),
        session.server.data.location.provider.sync(location),
      ]).catch(() => synced.delete(location.directory))
    }

    const compact = new Intl.NumberFormat(ctx.locale.locale(), { notation: "compact", maximumFractionDigits: 1 })

    const goWindows = (session: MountedSession): Window[] => {
      const location = session.location
      if (!location) return []
      const go = session.server.data.location.usage.limits(location)?.go
      if (!go) return []
      return [
        { id: "5h", percent: go.rolling.percent, resetsAt: go.rolling.resetsAt, limited: go.rolling.limited },
        { id: "week", percent: go.weekly.percent, resetsAt: go.weekly.resetsAt, limited: go.weekly.limited },
        { id: "month", percent: go.monthly.percent, resetsAt: go.monthly.resetsAt, limited: go.monthly.limited },
      ]
    }

    const reportOf = (providerID: string) => (providerID === GO ? undefined : reports()[providerID])

    const windowsFor = (session: MountedSession, providerID: string): Window[] =>
      providerID === GO ? goWindows(session) : reportOf(providerID)?.windows ?? []

    const smallest = (session: MountedSession, providerID: string): Window | undefined => {
      const list = windowsFor(session, providerID)
      for (const id of WINDOW_ORDER) {
        const found = list.find((item) => item.id === id)
        if (found) return found
      }
      return list[0]
    }

    const nameOf = (session: MountedSession, providerID: string): string => {
      const location = session.location
      const known = location
        ? session.server.data.location.provider.list(location)?.find((item) => item.id === providerID)?.name
        : undefined
      return known ?? FALLBACK[providerID] ?? providerID
    }

    const formatLeft = (ms: number): string => {
      if (ms <= 0) return ctx.t("left.now")
      const minutes = Math.ceil(ms / 60_000)
      const hours = Math.floor(minutes / 60)
      const days = Math.floor(hours / 24)
      if (days > 0) return ctx.t("left.days", { days, hours: hours % 24 })
      if (hours > 0) return ctx.t("left.hours", { hours, minutes: minutes % 60 })
      return ctx.t("left.minutes", { minutes })
    }

    const percentText = (value?: number) => (value === undefined ? "—" : `${Math.round(value)}%`)

    const WindowRow = (props: { window: Window }) => {
      const color = () => toneColor(props.window.percent) ?? "var(--v2-text-text-muted)"
      const used = () =>
        props.window.used !== undefined && props.window.limit !== undefined
          ? ctx.t("window.used", { used: compact.format(props.window.used), limit: compact.format(props.window.limit) })
          : ""
      return (
        <div class="q-window">
          <div class="q-window-top">
            <span class="q-window-name">{ctx.t(WINDOW_KEY[props.window.id] ?? "window.5h")}</span>
            <span class="q-window-pct" style={{ color: color() }}>
              {percentText(props.window.percent)}
            </span>
          </div>
          <div class="q-bar" style={{ background: trackColor(props.window.percent) }}>
            <div class="q-bar-fill" style={{ width: `${clamp(props.window.percent)}%`, background: color() }} />
          </div>
          <div class="q-window-foot">
            <span>{used()}</span>
            <span>{props.window.resetsAt ? formatLeft(props.window.resetsAt - now()) : ""}</span>
          </div>
        </div>
      )
    }

    const Limits = (props: { session: MountedSession; screen: SessionScreen }) => {
      const [chosen, setChosen] = createSignal<string>()

      ensure(props.session)

      const current = () => props.screen.composer.model()?.providerID
      const expanded = () => chosen() ?? current() ?? GO

      const providers = createMemo(() =>
        KNOWN.filter((providerID) => {
          if (providerID === GO) return current() === GO || goWindows(props.session).length > 0
          return reportOf(providerID) !== undefined
        }),
      )

      const recent = () => {
        const stamps = Object.values(reports()).map((item) => item.fetchedAt)
        if (stamps.length === 0) return undefined
        return Math.min(...stamps)
      }

      const age = () => {
        const stamp = recent()
        return stamp === undefined ? undefined : now() - stamp
      }

      const status = () => {
        if (refreshing()) return ctx.t("refreshing")
        const value = age()
        if (value === undefined) return ""
        if (value < 5_000) return ctx.t("updated.now")
        return ctx.t("updated.ago", { time: formatLeft(value) })
      }

      return (
        <div class="q-panel">
          <div class="q-top">
            <span>{status()}</span>
            <ui.Tooltip value={ctx.t("refresh")}>
              <ui.IconButton icon="refresh" label={ctx.t("refresh")} busy={refreshing()} onClick={() => void load(true)} />
            </ui.Tooltip>
          </div>
          <For each={providers()}>
            {(providerID) => {
              const windows = () => windowsFor(props.session, providerID)
              const small = () => smallest(props.session, providerID)
              const open = () => expanded() === providerID
              return (
                <div class="q-item" data-open={open() ? "true" : "false"}>
                  <button class="q-head" aria-expanded={open()} onClick={() => setChosen(providerID)}>
                    <Ring percent={small()?.percent} size={16} loading={pendingFor(providerID)} />
                    <span class="q-name">{nameOf(props.session, providerID)}</span>
                    <span class="q-pct" style={{ color: toneColor(small()?.percent) }}>
                      {percentText(small()?.percent)}
                    </span>
                    <ui.Icon name={open() ? "chevron-down" : "chevron-right"} size="small" />
                  </button>
                  <Show when={open()}>
                    <div class="q-body">
                      <Show
                        when={windows().length > 0}
                        fallback={
                          <Show when={!reportOf(providerID)?.error}>
                            <span class="q-empty">{ctx.t("empty")}</span>
                          </Show>
                        }
                      >
                        <For each={windows()}>{(item) => <WindowRow window={item} />}</For>
                      </Show>
                          <Show when={reportOf(providerID)?.error}>
                            {(error) => (
                              <span class="q-error">
                                {error() === "no credential"
                                  ? ctx.t("error.noCredential")
                                  : ctx.t("error", { message: error() })}
                              </span>
                            )}
                          </Show>
                    </div>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      )
    }

    const tab: PanelTab = {
      id: "limits",
      get title() {
        return ctx.t("tab.title")
      },
      closable: "compact",
    }

    ctx.add(Panel, {
      id: "limits",
      region: "side",
      mobile: {
        get title() {
          return ctx.t("tab.title")
        },
        order: 55,
        kind: "menu",
        icon: "window-analytics",
      },
      list: (input) => (input.open.includes("limits") ? [tab] : []),
      render: (props) => <Limits session={props.session} screen={props.screen} />,
    })

    ctx.add(Slot, {
      at: "session.header",
      order: 20,
      render: (input) => {
        ensure(input.session)
        const provider = () => {
          const chosen = input.screen.composer.model()?.providerID
          if (chosen) return chosen
          return input.session.server.data.session.get(input.session.id)?.model?.providerID
        }
        const busy = () => {
          const id = provider()
          return id ? pendingFor(id) : false
        }
        const small = () => {
          const id = provider()
          return id ? smallest(input.session, id) : undefined
        }
        const title = () => {
          const id = provider()
          const found = small()
          if (!id || !found) return ctx.t("ring.none")
          return ctx.t("ring.title", {
            provider: nameOf(input.session, id),
            percent: Math.round(found.percent),
            time: found.resetsAt ? formatLeft(found.resetsAt - Date.now()) : "—",
          })
        }
        return (
          <button
            class="q-chip"
            data-tone={toneOf(small()?.percent)}
            title={title()}
            onClick={() => ctx.layout.open(`${ctx.id}:limits`, input.session, { tab: "select", background: true })}
          >
            <Ring percent={small()?.percent} size={14} loading={busy()} />
            <Show when={!input.compact}>
              <span>{percentText(small()?.percent)}</span>
            </Show>
          </button>
        )
      },
    })

    ctx.add(MenuItem, (): MenuItem => ({
      menu: "session.panel",
      id: "limits",
      title: ctx.t("menu.title"),
      icon: "window-analytics",
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(`${ctx.id}:limits`, session, { tab: "select", background: true })
      },
    }))

    ctx.add(Style, css)

    return () => {
      clearInterval(timer)
      clearInterval(tick)
    }
  },
})
