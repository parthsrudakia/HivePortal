import { requireSection } from "@/lib/section-access";

// Per-user section access (Settings → Access control). Sits inside the
// (app) loading boundary, so the spinner still shows while this resolves.
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireSection("properties");
  return children;
}
