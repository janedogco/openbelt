// Every catalog entry, bundled with the Worker, by its path (<family>/<entry>), with what its
// family's family.json says under what it says itself. Written by `bun run providers index` from
// the folder: don't edit it (the guard says when it's stale). The format is in README.md;
// src/providers.ts decodes them.
import googleFamily from "./google/family.json" with { type: "json" }
import asanaMcp from "./asana/mcp.json" with { type: "json" }
import atlassianMcp from "./atlassian/mcp.json" with { type: "json" }
import cloudflareDocs from "./cloudflare/docs.json" with { type: "json" }
import countriesGraphql from "./countries/graphql.json" with { type: "json" }
import deepwikiMcp from "./deepwiki/mcp.json" with { type: "json" }
import dropboxMcp from "./dropbox/mcp.json" with { type: "json" }
import frankfurterRest from "./frankfurter/rest.json" with { type: "json" }
import githubMcp from "./github/mcp.json" with { type: "json" }
import googleCalendar from "./google/calendar.json" with { type: "json" }
import googleCalendarApi from "./google/calendar-api.json" with { type: "json" }
import googleDocsApi from "./google/docs-api.json" with { type: "json" }
import googleDrive from "./google/drive.json" with { type: "json" }
import googleDriveApi from "./google/drive-api.json" with { type: "json" }
import googleGmail from "./google/gmail.json" with { type: "json" }
import googleGmailApi from "./google/gmail-api.json" with { type: "json" }
import googleSheetsApi from "./google/sheets-api.json" with { type: "json" }
import linearMcp from "./linear/mcp.json" with { type: "json" }
import mondayMcp from "./monday/mcp.json" with { type: "json" }
import notionMcp from "./notion/mcp.json" with { type: "json" }
import petstoreRest from "./petstore/rest.json" with { type: "json" }
import pokeapiRest from "./pokeapi/rest.json" with { type: "json" }
import sentryMcp from "./sentry/mcp.json" with { type: "json" }
import stripeMcp from "./stripe/mcp.json" with { type: "json" }
import supabaseMcp from "./supabase/mcp.json" with { type: "json" }
import weatherGovRest from "./weather-gov/rest.json" with { type: "json" }
import wikipediaRest from "./wikipedia/rest.json" with { type: "json" }
import xkcdRest from "./xkcd/rest.json" with { type: "json" }
import zendeskMcp from "./zendesk/mcp.json" with { type: "json" }

export const FILES = {
  "asana/mcp": asanaMcp,
  "atlassian/mcp": atlassianMcp,
  "cloudflare/docs": cloudflareDocs,
  "countries/graphql": countriesGraphql,
  "deepwiki/mcp": deepwikiMcp,
  "dropbox/mcp": dropboxMcp,
  "frankfurter/rest": frankfurterRest,
  "github/mcp": githubMcp,
  "google/calendar": { ...googleFamily, ...googleCalendar },
  "google/calendar-api": { ...googleFamily, ...googleCalendarApi },
  "google/docs-api": { ...googleFamily, ...googleDocsApi },
  "google/drive": { ...googleFamily, ...googleDrive },
  "google/drive-api": { ...googleFamily, ...googleDriveApi },
  "google/gmail": { ...googleFamily, ...googleGmail },
  "google/gmail-api": { ...googleFamily, ...googleGmailApi },
  "google/sheets-api": { ...googleFamily, ...googleSheetsApi },
  "linear/mcp": linearMcp,
  "monday/mcp": mondayMcp,
  "notion/mcp": notionMcp,
  "petstore/rest": petstoreRest,
  "pokeapi/rest": pokeapiRest,
  "sentry/mcp": sentryMcp,
  "stripe/mcp": stripeMcp,
  "supabase/mcp": supabaseMcp,
  "weather-gov/rest": weatherGovRest,
  "wikipedia/rest": wikipediaRest,
  "xkcd/rest": xkcdRest,
  "zendesk/mcp": zendeskMcp,
}
