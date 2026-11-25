import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";
import type { Database } from "./types";
import { retryFetch } from "./retry-fetch";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Reads that fail in transit are retried; writes never are.
      global: { fetch: retryFetch },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll can be called from a Server Component, where setting
            // cookies isn't allowed. The session refresh in proxy.ts handles it.
          }
        },
      },
    },
  );
}

/**
 * Request-stable client: every caller in the same request gets the same
 * instance. Required wherever the client is passed to argument-keyed
 * React cache() helpers (e.g. fetchLedgerSidecars) from more than one
 * component — a fresh client per call would silently defeat the dedupe.
 */
export const getCachedClient = cache(createClient);
