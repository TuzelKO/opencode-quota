export type Window = {
  id: string
  percent: number
  resetsAt?: number
  used?: number
  limit?: number
  unit?: "tokens" | "credits" | "requests"
  limited?: boolean
}

export type Probe = (key: string) => Promise<{ windows: Window[]; plan?: string }>

const TIMEOUT = 10_000

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)

const round = (value: number) => Math.round(value * 10) / 10

const json = async (url: string, key: string): Promise<unknown> => {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

// The plan quota endpoint behind the z.ai console: one row per window, with
// the consumed share as a percentage. Credits on plans that meter credits,
// tokens on plans that meter tokens. The China platform answers the same
// payload on its own host.
export const zaiProbe = (host: string): Probe => async (key) => {
  const body = (await json(`${host}/api/monitor/usage/quota/limit`, key)) as {
    data?: { level?: unknown; limits?: unknown }
  }
  const limits = Array.isArray(body?.data?.limits) ? body.data.limits : []
  const windows: Window[] = []
  for (const raw of limits) {
    const item = raw as Record<string, unknown>
    const unit = num(item.unit)
    const number = num(item.number)
    let id: string | undefined
    if (unit === 3 && number === 5) id = "5h"
    else if (unit === 6) id = "week"
    else if (unit === 5) id = "month"
    else if (unit === undefined && item.type === "TOKENS_LIMIT") id = "5h"
    const percentage = num(item.percentage)
    if (!id || percentage === undefined) continue
    windows.push({
      id,
      percent: round(percentage),
      resetsAt: num(item.nextResetTime),
      used: num(item.currentValue),
      limit: num(item.usage),
      unit: item.type === "CREDIT_LIMIT" ? "credits" : "tokens",
    })
  }
  return { windows, plan: text(body?.data?.level) }
}

// Kimi Code publishes the used share per pool (`limit_5h`, `limit_7d`,
// `limit_month_total`) next to the request-count windows. Each regional plan
// has its own host; the same key answers on both, so the global one tries both.
export const kimiProbe = (hosts: readonly string[]): Probe => async (key) => {
  let last: unknown
  for (const host of hosts) {
    try {
      const body = (await json(host, key)) as Record<string, unknown>
      const usages = (body.usages ?? {}) as Record<string, unknown>
      const windows: Window[] = []
      const add = (id: string, raw: unknown) => {
        const pool = raw as Record<string, unknown> | undefined
        const value = pool?.used_ratio
        const ratio = typeof value === "string" ? Number(value) : num(value)
        if (ratio === undefined || !Number.isFinite(ratio)) return
        const reset = typeof pool?.reset_time === "string" ? Date.parse(pool.reset_time) : NaN
        windows.push({ id, percent: round(ratio * 100), resetsAt: Number.isFinite(reset) ? reset : undefined })
      }
      add("5h", usages.limit_5h)
      add("week", usages.limit_7d)
      add("month", usages.limit_month_total ?? usages.limit_month_code)

      if (!windows.some((item) => item.id === "5h")) {
        const limits = Array.isArray(body.limits) ? body.limits : []
        const entry = limits.find((raw) => {
          const value = raw as { window?: { duration?: unknown; timeUnit?: unknown } }
          return value.window?.duration === 300 && value.window?.timeUnit === "TIME_UNIT_MINUTE"
        }) as { detail?: Record<string, unknown> } | undefined
        const detail = entry?.detail
        const limit = num(Number(detail?.limit))
        const remaining = num(Number(detail?.remaining))
        const used =
          num(Number(detail?.used)) ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined)
        if (limit !== undefined && limit > 0 && used !== undefined) {
          const reset = typeof detail?.resetTime === "string" ? Date.parse(detail.resetTime) : NaN
          windows.unshift({
            id: "5h",
            percent: round((used / limit) * 100),
            resetsAt: Number.isFinite(reset) ? reset : undefined,
            used,
            limit,
            unit: "requests",
          })
        }
      }

      const user = body.user as { membership?: { level?: unknown } } | undefined
      return { windows, plan: text(user?.membership?.level) }
    } catch (error) {
      last = error
    }
  }
  throw last ?? new Error("unreachable")
}
