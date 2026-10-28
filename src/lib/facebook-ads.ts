import type { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";

// Facebook ads setting for a room starting a fresh vacancy cycle: on for
// non-New York units, off for New York ones. If the property lookup fails we
// fall back to off, since staff can still switch ads on from /inventory.
export async function freshListingFacebookAds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  roomId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("rooms")
    .select("properties(is_new_york)")
    .eq("id", roomId)
    .maybeSingle();
  const isNewYork = one(data?.properties ?? null)?.is_new_york;
  return isNewYork === false;
}
