import { getBlockedSections, sectionForHref } from "@/lib/section-access";
import type { NavIconName } from "./nav-icons";

type NavItem = { href: string; label: string; icon: NavIconName };

/**
 * Drops the nav entries for sections the signed-in user is blocked from
 * (Settings → Access control). Rendered behind <Suspense> with the full,
 * ungated list as the fallback, so the shell stays synchronous and the
 * common (unrestricted) case never flickers. The pages themselves are
 * guarded by each section's layout — this only tidies the nav.
 */
export async function GatedNav({
  items,
  children,
}: {
  items: NavItem[];
  children: (items: NavItem[]) => React.ReactNode;
}) {
  const blocked = await getBlockedSections();
  if (blocked.size === 0) return children(items);
  return children(
    items.filter((item) => {
      const section = sectionForHref(item.href);
      return !section || !blocked.has(section);
    }),
  );
}
