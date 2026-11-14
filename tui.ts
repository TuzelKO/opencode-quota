// TUI plugins installed from npm keep their own Solid runtime unless the
// host's modules are imported through these ids, so signals created here never
// reach the host renderer otherwise (OpenCode issue #39986).
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, onCleanup, Show } from "opentui:runtime-module:solid-js"
import { jsx } from "opentui:runtime-module:%40opentui%2Fsolid%2Fjsx-runtime"
import { Quota } from "./rpc"

const runtime = jsx as unknown as (type: any, props: Record<string, any>, key?: any) => any

const h = (type: any, props: Record<string, any> = {}, ...children: any[]) =>
  runtime(type, children.length ? { ...props, children: children.length === 1 ? children[0] : children } : props)

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
const REMOTE = ["zai-coding-plan", "zhipuai-coding-plan", "kimi-code-plan-global", "kimi-code-plan-cn"]
const KNOWN = [GO, ...REMOTE]
const ORDER = ["5h", "week", "month"]

const NAMES: Record<string, string> = {
  "opencode-go": "OpenCode Go",
  "zai-coding-plan": "Z.AI Coding Plan",
  "zhipuai-coding-plan": "Zhipu AI Coding Plan",
  "kimi-code-plan-global": "Kimi For Coding",
  "kimi-code-plan-cn": "Kimi For Coding (CN)",
}

const SHORT: Record<string, string> = {
  "opencode-go": "Go",
  "zai-coding-plan": "Z.AI",
  "zhipuai-coding-plan": "Zhipu",
  "kimi-code-plan-global": "Kimi",
  "kimi-code-plan-cn": "Kimi CN",
}

const LABELS: Record<string, string> = { "5h": "5h", week: "Week", month: "Month" }

const WARN_AT = 70
const DANGER_AT = 90

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

type Tone = "normal" | "warning" | "danger"

const clamp = (value: number) => Math.max(0, Math.min(100, value))

const toneOf = (percent?: number): Tone =>
  percent === undefined ? "normal" : percent >= DANGER_AT ? "danger" : percent >= WARN_AT ? "warning" : "normal"

const percentText = (value?: number) => (value === undefined ? "—" : `${Math.round(value)}%`)

const bar = (percent: number, width = 10) => {
  const filled = Math.round((clamp(percent) / 100) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

const compact = (value: number) =>
  value >= 1_000_000
    ? `${Math.round(value / 100_000) / 10}M`
    : value >= 1_000
      ? `${Math.round(value / 100) / 10}k`
      : String(value)

const pad = (value: string, width: number) => value.padEnd(width).slice(0, width)

const left = (ms: number) => {
  if (ms <= 0) return "now"
  const minutes = Math.ceil(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

const smallest = (windows: Window[]): Window | undefined => {
  for (const id of ORDER) {
    const found = windows.find((item) => item.id === id)
    if (found) return found
  }
  return windows[0]
}

export default {
  id: "quota.tui",
  setup(context: Plugin.Context) {
    const theme = context.theme as any
    const base = () => theme.text?.base ?? "white"
    const muted = () => theme.text?.muted ?? base()
    const warning = () => theme.text?.feedback?.warning?.base ?? base()
    const error = () => theme.text?.feedback?.error?.base ?? base()

    const [reports, setReports] = createSignal<Record<string, Report>>({})
    const [go, setGo] = createSignal<Window[]>([])
    const [pending, setPending] = createSignal<Record<string, boolean>>({})
    const [now, setNow] = createSignal(Date.now())
    const [frame, setFrame] = createSignal(0)

    const pendingFor = (providerID: string) => pending()[providerID] === true
    const refreshing = () => REMOTE.some(pendingFor)

    const windowsFor = (providerID: string): Window[] =>
      providerID === GO ? go() : (reports()[providerID]?.windows ?? [])

    const baseDir = () => context.location?.directory ?? context.data.location.default().directory
    const options = () => {
      const directory = baseDir()
      return directory ? { location: { directory } } : undefined
    }

    const seen = new Map<string, Tone>()

    const notify = (providerID: string, windows: Window[]) => {
      for (const item of windows) {
        const key = `${providerID}:${item.id}`
        const tone = toneOf(item.percent)
        const previous = seen.get(key)
        seen.set(key, tone)
        if (!previous || previous === tone) continue
        if (tone !== "warning" && tone !== "danger") continue
        context.ui.toast.show({
          title: NAMES[providerID] ?? providerID,
          message: `${LABELS[item.id] ?? item.id} at ${Math.round(item.percent)}%`,
          variant: tone === "danger" ? "error" : "warning",
        })
      }
    }

    const loadRemote = async (providerID: string, force: boolean) => {
      if (pendingFor(providerID)) return
      setPending((prev) => ({ ...prev, [providerID]: true }))
      try {
        const result = (await context.client.rpc(Quota).usage({ providerID, force }, options())) as {
          providers: Report[]
        }
        const report = result.providers.find((item) => item.providerID === providerID)
        if (report) {
          setReports((prev) => ({ ...prev, [providerID]: report }))
          notify(providerID, report.windows)
        }
      } catch {
        // Keep the last numbers; the next tick retries.
      } finally {
        setPending((prev) => ({ ...prev, [providerID]: false }))
      }
    }

    const loadGo = async (force: boolean) => {
      void force
      try {
        const result = await context.client.experimental.usage.limits(options())
        const meter = result.data?.go
        const windows: Window[] = meter
          ? [
              { id: "5h", percent: meter.rolling.percent, resetsAt: meter.rolling.resetsAt },
              { id: "week", percent: meter.weekly.percent, resetsAt: meter.weekly.resetsAt },
              { id: "month", percent: meter.monthly.percent, resetsAt: meter.monthly.resetsAt },
            ]
          : []
        setGo(windows)
        notify(GO, windows)
      } catch {
        // Leave the last numbers alone.
      }
    }

    const refresh = (force = false) => {
      for (const providerID of REMOTE) void loadRemote(providerID, force)
      void loadGo(force)
    }

    void refresh()
    const slow = setInterval(() => refresh(), 60_000)
    const clock = setInterval(() => setNow(Date.now()), 30_000)
    const spin = setInterval(() => {
      if (refreshing()) setFrame((value) => (value + 1) % SPINNER.length)
    }, 120)

    const stop = context.data.on("server.connected", () => refresh())
    onCleanup(stop)

    const toneColor = (percent?: number) => {
      const tone = toneOf(percent)
      return tone === "danger" ? error() : tone === "warning" ? warning() : muted()
    }

    const providerOrder = () => {
      const current = context.ui.model.current()?.providerID
      const available = KNOWN.filter((id) => id === current || windowsFor(id).length > 0)
      return [...available].sort((leftID, rightID) => {
        if (leftID === current) return -1
        if (rightID === current) return 1
        return 0
      })
    }

    const WindowLine = (props: { window: Window; width: number }) => {
      const used = () =>
        props.window.used !== undefined && props.window.limit !== undefined
          ? `${compact(props.window.used)}/${compact(props.window.limit)}`
          : ""
      return h(
        "text",
        {
          get fg() {
            return toneColor(props.window.percent)
          },
          wrapMode: "none",
          get children() {
            const reset = props.window.resetsAt ? left(props.window.resetsAt - now()) : ""
            const barWidth = Math.max(6, props.width - 40)
            return `  ${pad(LABELS[props.window.id] ?? props.window.id, 5)} ${bar(
              props.window.percent,
              barWidth,
            )} ${percentText(props.window.percent).padStart(4)}  ${pad(used(), 12)} ${reset}`
          },
        },
      )
    }

    const ProviderBlock = (props: { providerID: string; width: number }) => {
      const windows = () => windowsFor(props.providerID)
      const small = () => smallest(windows())
      const current = () => context.ui.model.current()?.providerID === props.providerID
      const report = () => reports()[props.providerID]
      return h(
        "box",
        { flexDirection: "column", marginTop: 1 },
        h(
          "text",
          {
            get fg() {
              return current() ? base() : muted()
            },
            wrapMode: "none",
            get children() {
              const name = `${current() ? "●" : "○"} ${NAMES[props.providerID] ?? props.providerID}`
              const pct = percentText(small()?.percent)
              const space = Math.max(1, props.width - name.length - pct.length - 3)
              return name + " ".repeat(space) + pct
            },
          },
        ),
        h(
          For,
          { get each() { return windows() } },
          (item: Window) => h(WindowLine, { window: item, get width() { return props.width } }),
        ),
        h(
          Show,
          { get when() { return report()?.error !== undefined } },
          h(
            "text",
            {
              get fg() {
                return error()
              },
              wrapMode: "none",
              get children() {
                return `  ${report()?.error}`
              },
            },
          ),
        ),
      )
    }

    const Panel = (props: { width: number }) => {
      const stamp = () => {
        const values = Object.values(reports()).map((item) => item.fetchedAt)
        if (values.length === 0) return ""
        const age = now() - Math.min(...values)
        return age < 5_000 ? "updated just now" : `updated ${left(age)} ago`
      }
      return h(
        "box",
        { flexDirection: "column", padding: 1, flexGrow: 1, width: "100%" },
        h(
          "text",
          {
            get fg() {
              return base()
            },
            wrapMode: "none",
            get children() {
              const title = refreshing() ? "Quota · refreshing…" : `Quota · ${stamp()}`
              const hint = "/quota refresh"
              const space = Math.max(1, props.width - title.length - hint.length - 2)
              return title + " ".repeat(space) + hint
            },
          },
        ),
        h(
          For,
          { get each() { return providerOrder() } },
          (providerID: string) => h(ProviderBlock, { providerID, get width() { return props.width } }),
        ),
        h(
          Show,
          { get when() { return providerOrder().length === 0 } },
          h(
            "text",
            {
              get fg() {
                return muted()
              },
              wrapMode: "none",
            },
            "No connected providers report quota.",
          ),
        ),
      )
    }

    const Badge = () => {
      const provider = () => context.ui.model.current()?.providerID
      const small = () => {
        const id = provider()
        return id ? smallest(windowsFor(id)) : undefined
      }
      const busy = () => {
        const id = provider()
        return id ? pendingFor(id) : false
      }
      return h(
        "text",
        {
          wrapMode: "none",
          get fg() {
            return busy() ? muted() : toneColor(small()?.percent)
          },
          get children() {
            const id = provider()
            if (!id) return ""
            if (busy()) return `${SPINNER[frame()]} ${SHORT[id] ?? id}`
            return `${SHORT[id] ?? id} ${percentText(small()?.percent)}`
          },
        },
      )
    }

    context.ui.slot({ append: "prompt.footer.status", render: () => h(Badge) })
    context.ui.slot({
      append: "session.panel",
      render: (panel: { name: string; width: number }) =>
        h(
          Show,
          { get when() { return panel.name === "quota" } },
          h(Panel, {
            get width() {
              return panel.width
            },
          }),
        ),
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "quota.open",
          title: "Quota",
          description: "Provider spend windows",
          group: "Quota",
          palette: true,
          slash: { name: "quota", arguments: true },
          run: (input?: string) => {
            if (input?.trim() === "refresh") refresh(true)
            if (!context.ui.panel.open("quota"))
              context.ui.toast.show({ message: "Open a session to show quota", variant: "warning" })
          },
        },
        {
          id: "quota.refresh",
          title: "Refresh quota",
          group: "Quota",
          palette: true,
          run: () => refresh(true),
        },
      ],
    }))

    return () => {
      clearInterval(slow)
      clearInterval(clock)
      clearInterval(spin)
    }
  },
}
