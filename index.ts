import { Plugin } from "@opencode/plugin"
import { kimiProbe, zaiProbe, type Probe, type Window } from "./probe"
import { Quota } from "./rpc"

type Report = {
  providerID: string
  plan?: string
  windows: Window[]
  error?: string
  fetchedAt: number
}

const TTL = 300_000

const cache = new Map<string, Report>()

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

// The RPC validates the returned object against the contract, and an explicit
// `undefined` fails an optional field instead of being dropped. Strip those
// keys so a provider that reports less than the schema allows still answers.
const clean = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(clean)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = clean(item)
    }
    return out
  }
  return value
}

const sources: { integrationID: string; probe: Probe }[] = [
  { integrationID: "zai-coding-plan", probe: zaiProbe("https://api.z.ai") },
  { integrationID: "zhipuai-coding-plan", probe: zaiProbe("https://open.bigmodel.cn") },
  {
    integrationID: "kimi-code-plan-global",
    probe: kimiProbe(["https://api.kimi.ai/coding/v1/usages", "https://api.kimi.com/coding/v1/usages"]),
  },
  { integrationID: "kimi-code-plan-cn", probe: kimiProbe(["https://api.kimi.com/coding/v1/usages"]) },
]

type Connection = { type?: string; name?: string }
type Resolved = { type?: string; key?: string; access?: string }
type CredentialSource = {
  integration: {
    connection: {
      active: (integrationID: string) => Promise<Connection | undefined>
      resolve: (connection: Connection) => Promise<Resolved | undefined>
    }
  }
}

type Credential = { connected: boolean; key?: string; error?: string }

const credentialFor = async (ctx: CredentialSource, integrationID: string): Promise<Credential> => {
  let connection: Connection | undefined
  try {
    connection = await ctx.integration.connection.active(integrationID)
  } catch {
    return { connected: false }
  }
  if (!connection) return { connected: false }
  try {
    const value = await ctx.integration.connection.resolve(connection)
    const key = value?.type === "oauth" ? value.access : value?.key
    if (key) return { connected: true, key }
    if (connection.type === "env" && connection.name && process.env[connection.name])
      return { connected: true, key: process.env[connection.name] }
    return { connected: true, error: "no credential" }
  } catch (error) {
    return { connected: true, error: message(error) }
  }
}

export default Plugin.define({
  id: "quota",
  async setup(ctx) {
    await ctx.rpc.register(Quota, {
      usage: async (input) => {
        const options = input as { force?: boolean; providerID?: string } | undefined
        const force = options?.force === true
        const only = options?.providerID
        const now = Date.now()
        const providers: Report[] = []
        const selected = only ? sources.filter((source) => source.integrationID === only) : sources

        for (const source of selected) {
          const cached = cache.get(source.integrationID)
          if (!force && cached && now - cached.fetchedAt < TTL) {
            providers.push(cached)
            continue
          }
          let report: Report
          const credential = await credentialFor(ctx as unknown as CredentialSource, source.integrationID)
          if (!credential.connected) continue
          if (!credential.key) {
            report = {
              providerID: source.integrationID,
              windows: cached?.windows ?? [],
              error: credential.error ?? "no credential",
              fetchedAt: now,
            }
          } else {
            try {
              const probe = await source.probe(credential.key)
              report = { providerID: source.integrationID, ...probe, fetchedAt: now }
            } catch (error) {
              report = {
                providerID: source.integrationID,
                windows: cached?.windows ?? [],
                error: message(error),
                fetchedAt: now,
              }
            }
          }
          cache.set(source.integrationID, report)
          providers.push(report)
        }

        return clean({ providers }) as { providers: Report[] }
      },
    })
  },
})
