type CatalogTools = ReadonlyArray<readonly [string, boolean]>

const SERVERS = {
  slack: [
    ["search_messages", true],
    ["list_channels", true],
    ["read_channel", true],
    ["post_message", false],
  ],
  sentry: [
    ["list_issues", true],
    ["get_event", true],
    ["resolve_issue", false],
  ],
  datadog: [
    ["query_metrics", true],
    ["list_monitors", true],
    ["mute_monitor", false],
  ],
  pagerduty: [
    ["list_incidents", true],
    ["who_is_on_call", true],
    ["acknowledge", false],
    ["create_incident", false],
  ],
  notion: [
    ["search", true],
    ["get_page", true],
    ["create_page", false],
    ["update_page", false],
  ],
  figma: [
    ["get_file", true],
    ["list_comments", true],
    ["post_comment", false],
  ],
  stripe: [
    ["list_customers", true],
    ["get_invoice", true],
    ["list_charges", true],
    ["create_refund", false],
    ["update_subscription", false],
  ],
  salesforce: [
    ["search_accounts", true],
    ["get_opportunity", true],
    ["update_opportunity", false],
    ["log_call", false],
  ],
  hubspot: [
    ["search_contacts", true],
    ["get_deal", true],
    ["create_note", false],
  ],
  zendesk: [
    ["search_tickets", true],
    ["get_ticket", true],
    ["reply", false],
    ["close_ticket", false],
  ],
  intercom: [
    ["search_conversations", true],
    ["reply", false],
  ],
  snowflake: [
    ["run_query", true],
    ["list_tables", true],
  ],
  looker: [
    ["run_look", true],
    ["list_dashboards", true],
  ],
  gdrive: [
    ["search_files", true],
    ["read_file", true],
    ["create_doc", false],
  ],
  gcal: [
    ["list_events", true],
    ["create_event", false],
  ],
  quickbooks: [
    ["list_invoices", true],
    ["create_invoice", false],
  ],
  greenhouse: [
    ["list_candidates", true],
    ["get_scorecard", true],
  ],
  vercel: [
    ["list_deployments", true],
    ["get_logs", true],
    ["promote", false],
  ],
  okta: [
    ["list_users", true],
    ["list_groups", true],
  ],
} satisfies Readonly<Record<string, CatalogTools>>

export const CATALOG = new Map<string, CatalogTools>(Object.entries(SERVERS))

export const catalogTools = (name: string) =>
  (CATALOG.get(name) ?? []).map(([tool, reads]) => ({
    name: tool,
    description: `${reads ? "Read" : "Change"} ${name}: ${tool.replaceAll("_", " ")}.`,
    inputSchema: { type: "object", properties: {} },
    annotations: reads ? { readOnlyHint: true } : { destructiveHint: false },
  }))
