/**
 * Tool handlers shared between the Telegram bot and (eventually) any other
 * agent host. Same operations as the MCP server in mcp/, but written for
 * the Next.js + Supabase environment.
 *
 * Each handler returns a JSON-serialisable result. The Claude tool runner
 * stringifies these into tool_result content blocks.
 *
 * Layout: one file per domain (handlers + their betaZodTool definitions),
 * shared plumbing in context.ts / helpers.ts / instrument.ts. Import
 * direction is index → domains → helpers/context; no domain file may import
 * this index (no cycles).
 */

export { runWithToolContext, getToolContext, type ToolContext } from "./context";

import { instrumentTool } from "./instrument";
import { propertiesTools } from "./properties";
import { roomsTools } from "./rooms";
import { tenantsTools } from "./tenants";
import { tenanciesTools } from "./tenancies";
import { agreementsTools } from "./agreements";
import { paymentsTools } from "./payments";
import { messagingTools } from "./messaging";
import { cleaningTools } from "./cleaning";
import { utilitiesTools } from "./utilities";
import { analyticsTools } from "./analytics";
import { queryTools } from "./query";

const rawTools = [
  ...propertiesTools,
  ...roomsTools,
  ...tenantsTools,
  ...tenanciesTools,
  ...agreementsTools,
  ...paymentsTools,
  ...messagingTools,
  ...cleaningTools,
  ...utilitiesTools,
  ...analyticsTools,
  ...queryTools,
];

// instrumentTool mutates each tool's `run` in place — it must be applied
// exactly once, and only here.
export const tools = rawTools.map(instrumentTool);
