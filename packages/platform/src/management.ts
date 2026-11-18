import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { McpSchema } from "effect/ai"
import {
  AgentApps,
  AppName,
  CredentialOwner,
  Email,
  Level,
  Refused,
  type Json,
  type ManagementAnswer,
} from "./model.ts"
import { CatalogAdd } from "./providers.ts"
import { NOTE_MAX } from "./connections.ts"

type CliCommand = { readonly usage: string; readonly summary: string; workspace?: boolean }

type Request = { readonly route: string; readonly method: "GET" | "POST"; readonly text: string }

type Call = (
  route: string,
  method: "GET" | "POST",
  text: string,
) => Effect.Effect<ManagementAnswer, Refused>

const object = Schema.Record(Schema.String, Schema.Json)

const inputJson = Schema.decodeUnknownSync(McpSchema.ToolJson)

const outputJson = Schema.decodeUnknownSync(McpSchema.ToolOutputJson)(
  Schema.toJsonSchemaDocument(object).schema,
)

const named = { connection: Schema.String }

const requestedLevel = Schema.Literals(["read", "all"])

const role = Schema.Literals(["admin", "member"])

const policy = Schema.Literals(["none", "read", "all", "unset"])

const post = (route: string, body: Readonly<Record<string, Json | undefined>> = {}): Request => ({
  route,
  method: "POST",
  text: JSON.stringify(body),
})

const get = (route: string): Request => ({ route, method: "GET", text: "" })

const path = (connection: string, suffix: string, workspace = false) =>
  `${workspace ? "workspace" : "me"}/connections/${encodeURIComponent(connection)}/${suffix}`

export const openManagement = (call: Call) => {
  const operation = <F extends Schema.Struct.Fields>(config: {
    readonly name: string
    readonly description: string
    readonly parameters: F
    readonly request: (params: Schema.Struct<F>["Type"]) => Request
    readonly usage: string
    readonly admin?: boolean
    readonly workspace?: boolean
    readonly readonly?: boolean
    /** Only under email sign-in, where people make workspaces (base.ts); hidden otherwise. */
    readonly emailSignIn?: boolean
  }) => {
    const schema = Schema.Struct(config.parameters)
    const decode = Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })

    const command: CliCommand = {
      usage: config.usage,
      summary: config.description.split(". ")[0] ?? config.description,
    }

    if (config.workspace) command.workspace = true

    const tool = new McpSchema.Tool({
      name: config.name,
      description: config.description,
      inputSchema: inputJson({
        type: "object",
        ...Schema.toJsonSchemaDocument(schema).schema,
        additionalProperties: false,
      }),
      outputSchema: outputJson,
      annotations: { readOnlyHint: config.readonly ?? false },
      _meta: {
        "openbelt/cli": [command],
      },
    })

    return {
      tool,
      admin: config.admin ?? false,
      emailSignIn: config.emailSignIn ?? false,
      handle: (payload: Json | undefined) =>
        decode(payload ?? {}).pipe(
          Effect.mapError(
            (cause) =>
              new Refused({
                message: `${config.name}'s arguments don't fit: ${cause.message.replaceAll(/\s*\n\s*/g, " ")}`,
              }),
          ),
          Effect.flatMap((params) => {
            const request = config.request(params)

            return call(request.route, request.method, request.text)
          }),
          Effect.map(
            (answer) =>
              new McpSchema.CallToolResult({
                isError: answer.status >= 400,
                structuredContent: answer.body,
                content: [{ type: "text", text: JSON.stringify(answer.body) }],
              }),
          ),
          Effect.catchTag("Refused", (cause) =>
            Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                structuredContent: { error: cause.message, code: "refused" },
                content: [
                  { type: "text", text: JSON.stringify({ error: cause.message, code: "refused" }) },
                ],
              }),
            ),
          ),
        ),
    }
  }

  return [
    operation({
      name: "connection_connect",
      description:
        "Start signing in to a connection with your own account. Return the authorization URL for the person to open; connection discovery shows when sign-in has finished.",
      parameters: { ...named, scope: Schema.optionalKey(Schema.String) },
      request: ({ connection, scope }) => post(path(connection, "connect"), { scope }),
      usage: "connection connect <connection>",
    }),
    operation({
      name: "connection_disconnect",
      description:
        "Disconnect your account from a connection, clearing its credential. Apps can no longer use it as you until you connect again.",
      parameters: named,
      request: ({ connection }) => post(path(connection, "token/clear")),
      usage: "connection disconnect <connection>",
    }),
    operation({
      name: "connection_token_set",
      description:
        "Set your personal token for a connection. Supply the credential through your agent's secure secret input; never put it in an app or ordinary chat.",
      parameters: { ...named, token: Schema.String },
      request: ({ connection, token }) => ({
        route: path(connection, "token"),
        method: "POST",
        text: token,
      }),
      usage: "connection token <connection> [token]",
    }),
    operation({
      name: "connection_preferences_set",
      description:
        "Restrict a connection for yourself to none, read, or all the tools your workspace grants you. This cannot increase your workspace access; connection_access_request asks for more.",
      parameters: { ...named, level: Level },
      request: ({ connection, level }) => post(path(connection, "own"), { level }),
      usage: "connection access <connection>",
    }),
    operation({
      name: "connection_tool_preferences_set",
      description: "Turn one connection tool on or off for yourself, within your workspace access.",
      parameters: { ...named, tool: Schema.String, on: Schema.Boolean },
      request: ({ connection, tool, on }) => post(path(connection, "own/tool"), { tool, on }),
      usage: "connection tool <connection> <tool>",
    }),
    operation({
      name: "connection_access_request",
      description:
        "Ask workspace admins for read or all access to a connection. The request does not grant access; include a note saying why it is needed.",
      parameters: {
        ...named,
        want: requestedLevel,
        note: Schema.optionalKey(Schema.String).annotate({
          description: `Why you need access, at most ${NOTE_MAX} characters`,
        }),
      },
      request: ({ connection, want, note }) => post(path(connection, "ask"), { want, note }),
      usage: "connection request <connection> <want>",
    }),
    operation({
      name: "connection_access_request_cancel",
      description: "Withdraw your pending request for more access to a connection.",
      parameters: named,
      request: ({ connection }) => post(path(connection, "ask/cancel")),
      usage: "connection request-cancel <connection>",
    }),
    operation({
      name: "connection_consent_list",
      description:
        "List the apps you allowed to use your personal connections, the exact tools allowed, and pending requests from apps.",
      parameters: {},
      request: () => get("me/consents"),
      usage: "connection consent list",
      readonly: true,
    }),
    operation({
      name: "connection_consent_grant",
      description:
        "Allow an app to use your personal connection, as you, for its exact viewer-bound tools. Pass bare tool names without the connection prefix; app_info shows its bindings. This grants no other person's credentials.",
      parameters: {
        app: Schema.String,
        ...named,
        tools: Schema.Array(Schema.String),
        preview: Schema.optionalKey(Schema.String),
      },
      request: (params) => post("me/consents/grant", params),
      usage: "connection consent grant <app> <connection>",
    }),
    operation({
      name: "connection_consent_revoke",
      description: "Revoke an app's use of your personal connection.",
      parameters: { app: Schema.String, ...named },
      request: (params) => post("me/consents/revoke", params),
      usage: "connection consent revoke <app> <connection>",
    }),
    operation({
      name: "connection_consent_dismiss",
      description:
        "Dismiss an app's pending request to use your personal connection. It may ask again when someone next needs the tool.",
      parameters: { app: Schema.String, ...named },
      request: (params) => post("me/consents/dismiss", params),
      usage: "connection consent dismiss <app> <connection>",
    }),
    operation({
      name: "token_list",
      description: "List your API tokens by id and expiry; token values are never returned.",
      parameters: {},
      request: () => get("me/tokens"),
      usage: "token list",
      readonly: true,
    }),
    operation({
      name: "token_create",
      description:
        "Create an API token acting as you in this workspace. Its value is returned once with mcp_url, the only address that accepts it (this workspace's host, not the base host's one MCP address); keep both in a credential store. Without days it does not expire. apps limits it to those apps: an agent using it can't see, open, make or change any other (without apps it may use every app; a token made by an agent limited to some apps gets at most those).",
      parameters: {
        label: Schema.optionalKey(Schema.String),
        days: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }))),
        apps: Schema.optionalKey(Schema.Array(AppName)),
      },
      request: (params) => post("me/tokens/create", params),
      usage: "token create",
    }),
    operation({
      name: "token_apps_set",
      description:
        "Limit one of your API tokens (by id from token_list) to some apps, or give it every app again with apps: null. It takes effect on its next request.",
      parameters: { id: Schema.String, apps: AgentApps },
      request: (params) => post("me/tokens/apps", params),
      usage: "token apps <id> <apps...>",
    }),
    operation({
      name: "token_revoke",
      description:
        "Revoke one of your API tokens by id from token_list. Requests using it stop working immediately.",
      parameters: { id: Schema.String },
      request: (params) => post("me/tokens/revoke", params),
      usage: "token revoke <id>",
    }),
    operation({
      name: "agent_signins",
      description:
        "List agents signed in as you with OAuth, including their grant ids and last use.",
      parameters: {},
      request: () => get("me/signins"),
      usage: "agent list",
      readonly: true,
    }),
    operation({
      name: "agent_apps_set",
      description:
        "Limit one of your signed-in agents (by grant id from agent_signins) to some apps, or give it every app again with apps: null. Its next sign-in keeps the same apps.",
      parameters: { id: Schema.String, apps: AgentApps },
      request: (params) => post("me/signins/apps", params),
      usage: "agent apps <id> <apps...>",
    }),
    operation({
      name: "agent_signout",
      description:
        "Sign out one of your OAuth agents by grant id from agent_signins. Its access and refresh tokens are revoked.",
      parameters: { id: Schema.String },
      request: (params) => post("me/signins/revoke", params),
      usage: "agent signout <id>",
    }),
    operation({
      name: "people_list",
      description:
        "List workspace people, roles, status, groups, and the joining policy. Workspace admin only.",
      parameters: {},
      request: () => get("workspace/people"),
      usage: "people list",
      admin: true,
      readonly: true,
    }),
    operation({
      name: "people_invite",
      description:
        "Invite someone into this workspace, or restore a removed person. Workspace admin only; role defaults to member.",
      parameters: {
        email: Email,
        name: Schema.optionalKey(Schema.String),
        role: Schema.optionalKey(role),
      },
      request: (params) => post("workspace/people/invite", params),
      usage: "people invite <email>",
      admin: true,
    }),
    operation({
      name: "people_remove",
      description:
        "Remove someone from the workspace, revoking their credentials and closing their app pages. Workspace admin only; the last admin cannot be removed.",
      parameters: { person: Schema.String },
      request: (params) => post("workspace/people/remove", params),
      usage: "people remove <person>",
      admin: true,
    }),
    operation({
      name: "people_role_set",
      description:
        "Set a person's workspace role to admin or member. Workspace admin only; the last admin cannot be demoted.",
      parameters: { person: Schema.String, role },
      request: (params) => post("workspace/people/role", params),
      usage: "people role <person> <role>",
      admin: true,
    }),
    operation({
      name: "group_list",
      description: "List workspace groups and their members. Workspace admin only.",
      parameters: {},
      request: () => get("workspace/groups"),
      usage: "group list",
      admin: true,
      readonly: true,
    }),
    operation({
      name: "group_create",
      description:
        "Create a workspace group. Workspace admin only; use lowercase letters, digits, and dashes.",
      parameters: { name: Schema.String },
      request: (params) => post("workspace/groups/create", params),
      usage: "group create <name>",
      admin: true,
    }),
    operation({
      name: "group_delete",
      description:
        "Delete a workspace-managed group and its access levels. Directory-synced groups must be changed in the directory. Workspace admin only.",
      parameters: { name: Schema.String },
      request: (params) => post("workspace/groups/delete", params),
      usage: "group delete <name>",
      admin: true,
    }),
    operation({
      name: "group_member_add",
      description: "Add a workspace person to a workspace-managed group. Workspace admin only.",
      parameters: { group: Schema.String, person: Schema.String },
      request: (params) => post("workspace/groups/add", params),
      usage: "group add <group> <person>",
      admin: true,
    }),
    operation({
      name: "group_member_remove",
      description: "Remove a person from a workspace-managed group. Workspace admin only.",
      parameters: { group: Schema.String, person: Schema.String },
      request: (params) => post("workspace/groups/remove", params),
      usage: "group remove <group> <person>",
      admin: true,
    }),
    operation({
      name: "workspace_joining_set",
      description:
        "Set whether the workspace accepts anyone who can sign in or only invited people. Workspace admin only.",
      parameters: { joining: Schema.Literals(["open", "invite"]) },
      request: (params) => post("workspace/joining", params),
      usage: "workspace joining <joining>",
      admin: true,
    }),
    operation({
      name: "workspace_embed_set",
      description:
        "Set which of the workspace's apps may embed its other apps in a frame (an app builder showing the app it builds, live or in a preview environment). Every other app stays unframeable, so no app can lay another under a fake button. [] for none, the default. Workspace admin only.",
      parameters: { apps: Schema.Array(Schema.String) },
      request: (params) => post("workspace/embed", params),
      usage: "workspace embed <apps>",
      admin: true,
    }),
    operation({
      name: "workspace_rename",
      description:
        "Rename the workspace and its hosts. Existing names and tokens keep working; a trial must be claimed first. Workspace admin only.",
      parameters: { to: Schema.String },
      request: (params) => post("workspace/rename", params),
      usage: "workspace rename <to>",
      admin: true,
    }),
    operation({
      name: "workspace_create",
      description:
        "Create a new workspace with you as its first admin, invite-only. Returns its URLs and an API token acting as you there, once; this connection stays on the current workspace. Use the token for the new workspace's mcp_url.",
      parameters: { name: Schema.String },
      request: (params) => post("workspaces/create", params),
      usage: "workspace create <name>",
      emailSignIn: true,
    }),
    operation({
      name: "workspace_join_requests",
      description:
        "List people waiting to join this workspace. Use people_invite to admit one. Workspace admin only.",
      parameters: {},
      request: () => get("workspace/join-requests"),
      usage: "workspace requests",
      admin: true,
      readonly: true,
    }),
    operation({
      name: "workspace_token_list",
      description:
        "List API tokens across the workspace, without token values. Workspace admin only.",
      parameters: {},
      request: () => get("workspace/tokens"),
      usage: "token list",
      admin: true,
      workspace: true,
      readonly: true,
    }),
    operation({
      name: "workspace_token_revoke",
      description: "Revoke any API token in the workspace by id. Workspace admin only.",
      parameters: { id: Schema.String },
      request: (params) => post("workspace/tokens/revoke", params),
      usage: "token revoke <id>",
      admin: true,
      workspace: true,
    }),
    operation({
      name: "scim_status",
      description:
        "List directory-sync tokens and recent provisioning requests. Workspace admin only.",
      parameters: {},
      request: () => get("workspace/scim"),
      usage: "scim status",
      admin: true,
      readonly: true,
    }),
    operation({
      name: "scim_token_create",
      description: "Create a SCIM directory-sync token, returned once. Workspace admin only.",
      parameters: { label: Schema.optionalKey(Schema.String) },
      request: (params) => post("workspace/scim/token", params),
      usage: "scim token create",
      admin: true,
    }),
    operation({
      name: "scim_token_revoke",
      description: "Revoke a directory-sync token by id from scim_status. Workspace admin only.",
      parameters: { id: Schema.String },
      request: (params) => post("workspace/scim/revoke", params),
      usage: "scim token revoke <id>",
      admin: true,
    }),
    operation({
      name: "connection_admin_list",
      description:
        "List all configured workspace connections and their setup, access policies, and credential status. Workspace admin only.",
      parameters: {},
      request: () => get("workspace/connections"),
      usage: "connection list",
      admin: true,
      workspace: true,
      readonly: true,
    }),
    operation({
      name: "connection_admin_info",
      description:
        "Inspect a connection's workspace configuration and access policy. Workspace admin only.",
      parameters: named,
      request: ({ connection }) => get(`workspace/connections/${encodeURIComponent(connection)}`),
      usage: "connection info <connection>",
      admin: true,
      workspace: true,
      readonly: true,
    }),
    operation({
      name: "connection_add",
      description:
        "Add a connection from OpenBelt's provider catalog. connections search returns provider ids in notAdded. An optional name selects another account of the same provider. Workspace admin only.",
      parameters: CatalogAdd.fields,
      request: (params) => post("workspace/connections/add", params),
      usage: "connection add <provider>",
      admin: true,
    }),
    operation({
      name: "connection_mcp_add",
      description:
        "Add a custom MCP server to the workspace. credential chooses none, workspace, person, or both; everyone defaults to read. Workspace admin only.",
      parameters: {
        name: Schema.String,
        url: Schema.String,
        credential: CredentialOwner,
        everyone: Schema.optionalKey(Level),
        signIn: Schema.optionalKey(Schema.Literals(["oauth", "token"])),
        scopes: Schema.optionalKey(Schema.String),
        authorizeParams: Schema.optionalKey(Schema.String),
      },
      request: (params) => post("workspace/connections/add", params),
      usage: "connection mcp-add <name> <url>",
      admin: true,
    }),
    operation({
      name: "connection_api_add",
      description:
        "Add an OpenAPI or GraphQL connection. OpenAPI needs spec; GraphQL needs url. auth is bearer, basic, header:<name>, or query:<name>. Workspace admin only.",
      parameters: {
        name: Schema.String,
        kind: Schema.Literals(["openapi", "graphql"]),
        spec: Schema.optionalKey(Schema.String),
        url: Schema.optionalKey(Schema.String),
        credential: CredentialOwner,
        everyone: Schema.optionalKey(Level),
        auth: Schema.optionalKey(Schema.String),
        tags: Schema.optionalKey(Schema.Array(Schema.String)),
      },
      request: (params) => post("workspace/connections/add", params),
      usage: "connection api-add <name> <kind>",
      admin: true,
    }),
    operation({
      name: "connection_remove",
      description:
        "Remove a workspace connection, its credentials, app consents, and access settings. Workspace admin only.",
      parameters: named,
      request: ({ connection }) => post("workspace/connections/remove", { name: connection }),
      usage: "connection remove <connection>",
      admin: true,
    }),
    operation({
      name: "connection_refresh",
      description:
        "Refresh a connection's tool list from its server or specification. Workspace admin only.",
      parameters: named,
      request: ({ connection }) => post("workspace/connections/refresh", { name: connection }),
      usage: "connection refresh <connection>",
      admin: true,
    }),
    operation({
      name: "connection_workspace_connect",
      description:
        "Start signing in to a connection with the workspace's shared account. Return its authorization link for a person to open. Workspace admin only.",
      parameters: { ...named, scope: Schema.optionalKey(Schema.String) },
      request: ({ connection, scope }) => post(path(connection, "connect", true), { scope }),
      usage: "connection connect <connection>",
      admin: true,
      workspace: true,
    }),
    operation({
      name: "connection_workspace_disconnect",
      description: "Disconnect a connection's shared workspace credential. Workspace admin only.",
      parameters: named,
      request: ({ connection }) => post(path(connection, "token/clear", true)),
      usage: "connection disconnect <connection>",
      admin: true,
      workspace: true,
    }),
    operation({
      name: "connection_workspace_token_set",
      description:
        "Set a connection's shared workspace token through secure credential input. Workspace admin only.",
      parameters: { ...named, token: Schema.String },
      request: ({ connection, token }) => ({
        route: path(connection, "token", true),
        method: "POST",
        text: token,
      }),
      usage: "connection token <connection> [token]",
      admin: true,
      workspace: true,
    }),
    operation({
      name: "connection_client_set",
      description:
        "Set a connection's registered OAuth client id and optional client secret. The result gives its callback URL. Workspace admin only.",
      parameters: { ...named, clientId: Schema.String, secret: Schema.optionalKey(Schema.String) },
      request: ({ connection, clientId, secret }) =>
        post(path(connection, "client", true), { clientId, secret }),
      usage: "connection client <connection> <clientId>",
      admin: true,
    }),
    operation({
      name: "connection_icon_set",
      description:
        "Set a connection's icon from a base64 image, at most 64 KB. type is its image MIME type. Workspace admin only.",
      parameters: { ...named, type: Schema.String, base64: Schema.String },
      request: ({ connection, type, base64 }) =>
        post(path(connection, "icon", true), { type, base64 }),
      usage: "connection icon set <connection>",
      admin: true,
    }),
    operation({
      name: "connection_icon_clear",
      description: "Reset a connection's icon. Workspace admin only.",
      parameters: named,
      request: ({ connection }) => post(path(connection, "icon/clear", true)),
      usage: "connection icon clear <connection>",
      admin: true,
    }),
    operation({
      name: "connection_access_set",
      description:
        "Set workspace access to a connection for everyone, a group, or a person. who is everyone, group:<name>, or person:<email>. unset removes an exception. Workspace admin only.",
      parameters: { ...named, who: Schema.String, level: policy },
      request: ({ connection, who, level }) => post("workspace/access", { connection, who, level }),
      usage: "connection access <connection>",
      admin: true,
      workspace: true,
    }),
    operation({
      name: "connection_tool_policy_set",
      description:
        "Disable, enable, or classify a connection tool as read-only for the workspace. read and unread change its classification. Workspace admin only.",
      parameters: {
        ...named,
        tool: Schema.String,
        change: Schema.Literals(["disable", "enable", "read", "unread"]),
      },
      request: (params) => post("workspace/access/tool", params),
      usage: "connection tool <connection> <tool>",
      admin: true,
      workspace: true,
    }),
    operation({
      name: "connection_access_requests",
      description:
        "List people's pending requests for more connection access, grouped by connection and desired level. Workspace admin only.",
      parameters: {},
      request: () => get("workspace/access/asks"),
      usage: "connection requests",
      admin: true,
      readonly: true,
    }),
    operation({
      name: "connection_access_request_grant",
      description:
        "Grant pending requests for a connection and level to one person, comma-separated people, or all pending requesters when neither is given. Workspace admin only.",
      parameters: {
        ...named,
        want: requestedLevel,
        person: Schema.optionalKey(Schema.String),
        people: Schema.optionalKey(Schema.String),
      },
      request: (params) => post("workspace/access/asks/grant", params),
      usage: "connection request-grant <connection> <want>",
      admin: true,
    }),
    operation({
      name: "connection_access_request_close",
      description:
        "Close pending requests for a connection and level without granting access. Restrict to person or comma-separated people, or leave both out for all. Workspace admin only.",
      parameters: {
        ...named,
        want: requestedLevel,
        person: Schema.optionalKey(Schema.String),
        people: Schema.optionalKey(Schema.String),
      },
      request: (params) => post("workspace/access/asks/close", params),
      usage: "connection request-close <connection> <want>",
      admin: true,
    }),
    operation({
      name: "connection_access_explain",
      description:
        "Check a person's effective access and explain why they can or cannot use a connection tool, optionally through an app. as selects workspace or personal credentials for an agent call. Workspace admin only.",
      parameters: {
        person: Schema.String,
        tool: Schema.String,
        as: Schema.optionalKey(Schema.Literals(["workspace", "me"])),
        app: Schema.optionalKey(Schema.String),
      },
      request: (params) => post("workspace/explain", params),
      usage: "connection explain <person> <tool>",
      admin: true,
      readonly: true,
    }),
    operation({
      name: "workspace_activity",
      description:
        "Inspect recent platform-tool and connection-tool activity, filtered by person, app, tool, connection, or outcome. Workspace admin only.",
      parameters: {
        connection: Schema.optionalKey(Schema.String),
        tool: Schema.optionalKey(Schema.String),
        person: Schema.optionalKey(Schema.String),
        app: Schema.optionalKey(Schema.String),
        outcome: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
      },
      request: (params) => post("workspace/activity", params),
      usage: "workspace activity",
      admin: true,
      readonly: true,
    }),
    operation({
      name: "connection_signin_refresh",
      description: "Refresh your connection's OAuth credential now, without changing its account.",
      parameters: named,
      request: ({ connection }) => post(path(connection, "signin/refresh")),
      usage: "connection renew <connection>",
    }),
    operation({
      name: "connection_workspace_signin_refresh",
      description:
        "Refresh a shared workspace connection's OAuth credential now. Workspace admin only.",
      parameters: named,
      request: ({ connection }) => post(path(connection, "signin/refresh", true)),
      usage: "connection renew <connection>",
      admin: true,
      workspace: true,
    }),
  ]
}
