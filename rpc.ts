import type { Rpc } from "@opencode/plugin/rpc"

/**
 * One spend window of a provider plan. `percent` is the share already used,
 * so the ring and the bars never have to know which way a provider counts.
 */
const window = {
  type: "object",
  properties: {
    id: { type: "string" },
    percent: { type: "number" },
    resetsAt: { type: "number" },
    used: { type: "number" },
    limit: { type: "number" },
    unit: { type: "string", enum: ["tokens", "credits", "requests"] },
    limited: { type: "boolean" },
  },
  required: ["id", "percent"],
  additionalProperties: false,
} as const

const report = {
  type: "object",
  properties: {
    providerID: { type: "string" },
    plan: { type: "string" },
    windows: { type: "array", items: window },
    error: { type: "string" },
    fetchedAt: { type: "number" },
  },
  required: ["providerID", "windows", "fetchedAt"],
  additionalProperties: false,
} as const

export const Quota = {
  id: "quota",
  methods: {
    usage: {
      input: {
        type: "object",
        properties: {
          force: { type: "boolean" },
          providerID: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { providers: { type: "array", items: report } },
        required: ["providers"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition
