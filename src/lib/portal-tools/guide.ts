import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

// ----- Portal guidebook (how the portal works: policies, thresholds,
// automations). The same content backs /guidebook.pdf in Settings. -----

export const guideTools = [
  betaZodTool({
    name: "get_portal_guide",
    description:
      "The portal operations guidebook: every automation, policy, and " +
      "calculation (emails and when they send, late-fee rules and " +
      "exemptions, how Collected/Expected KPIs are computed, the rent " +
      "ledger, reconciliation, cleaning schedules, utilities, agreements, " +
      "access rules). Call with no section to list section titles; pass " +
      "`section` to get one section's full text. Use this to answer any " +
      "'how does the portal work / why did X happen' question.",
    inputSchema: z.object({
      section: z
        .string()
        .optional()
        .describe(
          "Exact section title from the section list (call without it first to see titles)",
        ),
    }),
    run: async (args) => {
      const { GUIDEBOOK_SECTIONS } = await import("@/lib/guidebook");
      if (!args.section) {
        return JSON.stringify({
          sections: GUIDEBOOK_SECTIONS.map((s) => s.title),
        });
      }
      const wanted = args.section.trim().toLowerCase();
      const hit = GUIDEBOOK_SECTIONS.find(
        (s) => s.title.toLowerCase() === wanted,
      );
      if (!hit) {
        return JSON.stringify({
          error: "No such section",
          sections: GUIDEBOOK_SECTIONS.map((s) => s.title),
        });
      }
      return JSON.stringify({ title: hit.title, body: hit.body });
    },
  }),
];
