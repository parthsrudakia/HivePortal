import type { Database } from "@/lib/supabase/types";

export type Action = Database["public"]["Enums"]["listing_action"];

/** One ad posted for a room (a row in room_ads). */
export type AdRow = { id: string; url: string; posted_by: string | null };

export const ACTION_LABELS: Record<Action, string> = {
  no_action: "No action",
  update_price_or_date: "Price/date",
  delete_listing: "Delete",
  boost_post: "Boost",
  priority: "Priority",
};

export const ACTION_ORDER: Action[] = [
  "no_action",
  "update_price_or_date",
  "boost_post",
  "priority",
  "delete_listing",
];

// Literal class names so Tailwind's compiler picks them up.
export const ACTION_BORDER: Record<Action, string> = {
  no_action: "border-l-stone",
  update_price_or_date: "border-l-yellow-500",
  delete_listing: "border-l-red-500",
  boost_post: "border-l-orange-500",
  priority: "border-l-purple-500",
};

// Row background tint per action — a soft wash behind the whole row. The
// legend chips use the saturated ACTION_SWATCH (below) instead, so the tiny
// swatches read clearly even where dark mode dims these row tints.
export const ACTION_TINT: Record<Action, string> = {
  no_action: "bg-gray-50/60",
  update_price_or_date: "bg-yellow-200",
  delete_listing: "bg-red-200",
  boost_post: "bg-orange-200",
  priority: "bg-purple-200",
};

export const ACTION_PILL: Record<Action, string> = {
  no_action: "bg-gray-100 text-gray-700 border-gray-300",
  update_price_or_date: "bg-yellow-100 text-yellow-900 border-yellow-300",
  delete_listing: "bg-red-100 text-red-900 border-red-300",
  boost_post: "bg-orange-100 text-orange-900 border-orange-300",
  priority: "bg-purple-100 text-purple-900 border-purple-300",
};

export const ACTION_SWATCH: Record<Action, string> = {
  no_action: "bg-stone",
  update_price_or_date: "bg-yellow-500",
  delete_listing: "bg-red-500",
  boost_post: "bg-orange-500",
  priority: "bg-purple-500",
};
