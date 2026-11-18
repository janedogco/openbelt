export const SCALE_GROUPS = ["design", "data", "sales", "success", "finance"] as const

export type ScaleGroup = (typeof SCALE_GROUPS)[number] | "eng" | "contractors"

const NAMES: ReadonlyArray<readonly [string, string, ReadonlyArray<ScaleGroup>, boolean]> = [
  ["Dana", "Ruiz", ["finance"], true],
  ["Eli", "Park", ["eng"], true],
  ["Fay", "Okafor", ["design"], true],
  ["Gus", "Iverson", ["eng", "data"], true],
  ["Hana", "Sato", ["success"], true],
  ["Ivan", "Petrov", ["eng"], false],
  ["Jada", "Brooks", ["sales"], true],
  ["Kai", "Müller", ["data"], true],
  ["Lena", "Ortiz", ["design"], false],
  ["Milo", "Grant", ["eng", "contractors"], true],
  ["Nia", "Holt", ["success"], true],
  ["Omar", "Aziz", ["eng"], true],
  ["Pia", "Lund", ["finance"], false],
  ["Quinn", "Shaw", ["sales"], true],
  ["Rosa", "Vega", ["eng"], true],
  ["Sam", "Rhee", ["success", "contractors"], true],
  ["Tara", "Quist", ["design"], true],
  ["Uma", "Nair", ["data"], false],
  ["Vik", "Rao", ["eng"], true],
  ["Wes", "Ford", ["sales"], false],
  ["Xin", "Li", ["eng"], true],
  ["Yara", "Haddad", ["success"], true],
  ["Zed", "Moss", [], false],
  ["Abe", "Kim", ["eng"], true],
  ["Bea", "Stone", ["finance"], true],
  ["Cy", "Hart", ["eng", "contractors"], false],
  ["Dev", "Mehta", ["data"], true],
  ["Eva", "Lind", ["sales"], true],
  ["Finn", "Cole", [], false],
  ["Gia", "Russo", ["design"], true],
  ["Hal", "Ito", ["eng"], true],
  ["Ivy", "Wells", ["success"], false],
]

export const SCALE_PEOPLE = NAMES.map(([first, last, groups, tokens]) => ({
  email: `${first.toLowerCase()}@acme.test`,
  name: `${first} ${last}`,
  groups,
  tokens,
}))

type ScaleConnection = {
  readonly name: string
  readonly credential: "workspace" | "person" | "both"
  readonly everyone: "none" | "read" | "all"
  readonly groups: Readonly<Record<string, "none" | "read" | "all">>
  readonly people: Readonly<Record<string, "none" | "read" | "all">>
  readonly disabled: ReadonlyArray<string>
}

const c = (
  name: string,
  credential: ScaleConnection["credential"],
  everyone: ScaleConnection["everyone"],
  groups: ScaleConnection["groups"] = {},
  people: ScaleConnection["people"] = {},
  disabled: ReadonlyArray<string> = [],
): ScaleConnection => ({ name, credential, everyone, groups, people, disabled })

export const SCALE_CONNECTIONS: ReadonlyArray<ScaleConnection> = [
  c("slack", "person", "read", { contractors: "none" }),
  c("sentry", "workspace", "none", { eng: "all", success: "read" }),
  c("datadog", "workspace", "none", { eng: "all", data: "read" }),
  c("pagerduty", "both", "read", { eng: "all", contractors: "none" }),
  c("notion", "workspace", "read", { design: "all", eng: "all", sales: "all", success: "all" }),
  c("figma", "person", "read", { design: "all" }),
  c(
    "stripe",
    "workspace",
    "none",
    { finance: "all", success: "read" },
    { "ada@acme.test": "all" },
    ["create_refund"],
  ),
  c("salesforce", "person", "none", { sales: "all", success: "read" }),
  c("hubspot", "workspace", "none", { sales: "all" }),
  c("zendesk", "person", "none", { success: "all", eng: "read" }),
  c("intercom", "workspace", "none", { success: "all" }),
  c("snowflake", "person", "none", {
    data: "all",
    finance: "read",
    eng: "read",
    contractors: "none",
  }),
  c("looker", "workspace", "read", { contractors: "none" }),
  c("gdrive", "person", "read", { contractors: "none" }),
  c("gcal", "person", "all"),
  c("quickbooks", "workspace", "none", { finance: "all" }),
  c("greenhouse", "workspace", "none", {}, { "ada@acme.test": "read" }),
  c("vercel", "workspace", "none", { eng: "all", contractors: "none" }),
  c("okta", "workspace", "none", {}, { "ada@acme.test": "read" }),
]

export const SCALE_OWN: ReadonlyArray<
  readonly [string, string, "all" | "read" | "none", ReadonlyArray<string>]
> = [
  ["carol@acme.test", "notion", "read", []],
  ["carol@acme.test", "gcal", "all", ["create_event"]],
  ["eli@acme.test", "gcal", "all", ["create_event"]],
  ["omar@acme.test", "notion", "read", []],
  ["ada@acme.test", "stripe", "read", []],
  ["kai@acme.test", "looker", "none", []],
  ["rosa@acme.test", "pagerduty", "all", ["create_incident"]],
]

export const SCALE_ASKS: ReadonlyArray<readonly [string, string, string]> = [
  ["fay@acme.test", "vercel", "To check our preview deploys"],
  ["lena@acme.test", "vercel", ""],
  ["tara@acme.test", "vercel", "To check our preview deploys"],
  ["gia@acme.test", "vercel", ""],
  ["jada@acme.test", "vercel", ""],
  ["hana@acme.test", "vercel", "For the on-call rotation"],
  ["nia@acme.test", "vercel", ""],
  ["milo@acme.test", "vercel", "I ship the web app too"],
  ["dana@acme.test", "snowflake", ""],
  ["pia@acme.test", "snowflake", "For the quarterly report"],
  ["bea@acme.test", "snowflake", "For the quarterly report"],
  ["jada@acme.test", "snowflake", "I need to read the revenue tables"],
  ["quinn@acme.test", "snowflake", ""],
  ["eva@acme.test", "snowflake", ""],
  ["hana@acme.test", "sentry", "To see errors my customers hit"],
  ["fay@acme.test", "sentry", ""],
  ["tara@acme.test", "sentry", ""],
  ["eva@acme.test", "sentry", ""],
  ["kai@acme.test", "figma", "To leave comments on designs"],
  ["omar@acme.test", "figma", ""],
  ["jada@acme.test", "figma", ""],
  ["hana@acme.test", "stripe", "To look up a customer's invoices"],
  ["nia@acme.test", "stripe", ""],
  ["eli@acme.test", "github", "To open pull requests from my agent"],
  ["ivan@acme.test", "github", "To open pull requests from my agent"],
  ["fay@acme.test", "github", ""],
  ["kai@acme.test", "github", "Our release-notes app needs it"],
  ["sam@acme.test", "slack", "To post incident updates"],
  ["cy@acme.test", "slack", ""],
  ["zed@acme.test", "notion", ""],
  ["finn@acme.test", "notion", "To write up onboarding docs"],
]

export const SCALE_CALLS: ReadonlyArray<readonly [string, string]> = [
  ["eli@acme.test", "gcal.create_event"],
  ["eli@acme.test", "vercel.promote"],
  ["milo@acme.test", "vercel.list_deployments"],
  ["sam@acme.test", "slack.post_message"],
  ["hana@acme.test", "zendesk.reply"],
  ["hana@acme.test", "stripe.create_refund"],
  ["jada@acme.test", "salesforce.search_accounts"],
  ["kai@acme.test", "looker.run_look"],
  ["kai@acme.test", "snowflake.run_query"],
  ["dana@acme.test", "quickbooks.create_invoice"],
  ["fay@acme.test", "figma.post_comment"],
  ["fay@acme.test", "vercel.list_deployments"],
  ["omar@acme.test", "notion.create_page"],
  ["rosa@acme.test", "pagerduty.create_incident"],
  ["gus@acme.test", "datadog.query_metrics"],
  ["wes@acme.test", "hubspot.create_note"],
  ["zed@acme.test", "notion.search"],
]
