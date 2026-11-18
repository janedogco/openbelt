import { Schema } from "effect"

export type Json =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json }

const PROTOCOL = "2025-11-25"

const Reply = Schema.Struct({
  result: Schema.optional(Schema.Json),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})

const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.String),
      data: Schema.optional(Schema.String),
      mimeType: Schema.optional(Schema.String),
    }),
  ),
  structuredContent: Schema.optional(Schema.Json),
})

export type ToolResult = {
  readonly isError: boolean
  readonly text: string
  readonly structured: Json | undefined
  readonly image: { readonly data: string; readonly mimeType: string } | undefined
  readonly blocks: ReadonlyArray<string>
}

export type McpSession = {
  readonly request: (method: string, params: Readonly<Record<string, Json>>) => Promise<string>
  readonly call: (tool: string, args: Readonly<Record<string, Json>>) => Promise<ToolResult>
}

const messageOf = (body: string) =>
  body.trimStart().startsWith("{")
    ? body
    : (body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .findLast((line) => line.includes('"id"')) ?? body)

/** The name an agent's session gives: its tools/list is search and call. */
export const AGENT = "openbelt-verify-agent"

/**
 * `client` is the name initialize gives. Checks drive OpenBelt as the CLI does by default, so tools/list has every tool
 * with its schema; AGENT gets what an agent sees, search and call.
 */
export const connect = async (
  url: string,
  token: string,
  client = "openbelt-cli",
): Promise<McpSession> => {
  let id = 0
  let session: string | null = null

  const post = async (payload: Readonly<Record<string, Json>>) => {
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": PROTOCOL,
    })

    if (session !== null) headers.set("mcp-session-id", session)

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...payload }),
    })

    session = response.headers.get("mcp-session-id") ?? session

    return messageOf(await response.text())
  }

  const request = (method: string, params: Readonly<Record<string, Json>>) => {
    id += 1

    return post({ id, method, params })
  }

  await request("initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: client, version: "1" },
  })
  await post({ method: "notifications/initialized" })

  const call = async (tool: string, args: Readonly<Record<string, Json>>): Promise<ToolResult> => {
    const reply = Schema.decodeUnknownSync(Schema.fromJsonString(Reply))(
      await request("tools/call", { name: tool, arguments: args }),
    )

    if (reply.error !== undefined) {
      return {
        isError: true,
        text: `${reply.error.code}: ${reply.error.message}`,
        structured: undefined,
        image: undefined,
        blocks: [],
      }
    }

    const result = Schema.decodeUnknownSync(ToolResult)(reply.result)
    const image = result.content.find((c) => c.type === "image")

    return {
      isError: result.isError === true,
      text: result.content.map((c) => c.text ?? "").join("\n"),
      structured: result.structuredContent,
      image:
        image === undefined
          ? undefined
          : { data: image.data ?? "", mimeType: image.mimeType ?? "" },
      blocks: result.content.map((c) => c.type),
    }
  }

  return { request, call }
}
