export type Window = {
  id: string
  percent: number
  resetsAt?: number
  used?: number
  limit?: number
  unit?: "tokens" | "credits" | "requests"
  limited?: boolean
}

export type Probe = (key: string) => Promise<{ windows: Window[]; plan?: string; error?: string }>

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

// Step Plan answers the current cycle in one snapshot: the older coding plans
// carry rolling 5-hour and weekly windows, the credit plans a monthly pool and
// top-up packs. Every percentage is already the used share, unlike the
// console's remaining rates.
export const stepfunProbe = (host: string): Probe => async (key) => {
  const body = (await json(`${host}/step_plan/v1/usage`, key)) as {
    plan?: { name?: unknown; state?: unknown }
    quota?: {
      allowed?: unknown
      reason?: unknown
      state?: unknown
      windows?: unknown
      credit_buckets?: unknown
    }
  }
  const windows: Window[] = []
  const share = (value: number) => Math.min(100, Math.max(0, round(value)))

  const credits = (value: unknown): number | undefined => {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined
    const amount = Number(value)
    return Number.isSafeInteger(amount) ? amount : undefined
  }

  const push = (window: Window) => {
    if (windows.some((item) => item.id === window.id)) return
    windows.push(window)
  }

  const limits = Array.isArray(body?.quota?.windows) ? body.quota.windows : []
  for (const raw of limits) {
    if (!raw || typeof raw !== "object") continue
    const item = raw as Record<string, unknown>
    const id = item.id === "five_hour" ? "5h" : item.id === "weekly" ? "week" : undefined
    const percent = num(item.used_percent)
    if (!id || percent === undefined) continue
    push({ id, percent: share(percent), resetsAt: num(item.resets_at_ms) })
  }

  const buckets = Array.isArray(body?.quota?.credit_buckets) ? body.quota.credit_buckets : []
  for (const raw of buckets) {
    if (!raw || typeof raw !== "object") continue
    const item = raw as Record<string, unknown>
    const id = item.type === "subscription" ? "month" : item.type === "topup" ? "topup" : undefined
    const percent = num(item.used_percent)
    if (!id || percent === undefined) continue
    const limit = credits(item.total)
    const remaining = credits(item.remaining)
    push({
      id,
      percent: share(percent),
      // A credit bucket names the end of its cycle in expires_at_ms; resets_at_ms
      // is null for buckets that do not reset.
      resetsAt: num(item.resets_at_ms) ?? num(item.expires_at_ms),
      used:
        limit !== undefined && remaining !== undefined && limit > 0 && remaining <= limit
          ? limit - remaining
          : undefined,
      limit,
      unit: "credits",
    })
  }

  const quota = body?.quota
  const error =
    quota?.allowed === false
      ? text(quota.reason) ?? "quota exhausted"
      : quota?.state === "partial"
        ? "quota data is partial"
        : body?.plan?.state === "unavailable"
          ? "no active plan"
          : undefined

  return { windows, plan: text(body?.plan?.name), error }
}

// Kimi Code publishes the used share per pool (`limit_5h`, `limit_7d`,
// `limit_month_total`) next to the request-count windows. Each regional plan
// has its own host; the same key answers on both, so the global one tries both.
// The membership block left `/usages`, so the plan name comes from `/me`.
const kimiPlan = async (usageUrl: string, key: string): Promise<string | undefined> => {
  try {
    const url = new URL("/coding/v1/me", usageUrl).toString()
    const body = (await json(url, key)) as { user_level_name?: unknown }
    return text(body?.user_level_name)
  } catch {
    return undefined
  }
}

export const kimiProbe = (hosts: readonly string[]): Probe => async (key) => {
  let last: unknown
  for (const host of hosts) {
    try {
      const [response, profilePlan] = await Promise.all([json(host, key), kimiPlan(host, key)])
      const body = response as Record<string, unknown>
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
      return { windows, plan: profilePlan ?? text(user?.membership?.level) }
    } catch (error) {
      last = error
    }
  }
  throw last ?? new Error("unreachable")
}
