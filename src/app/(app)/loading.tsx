import { PageLoader } from "@/components/page-loader";

// Shown instantly on navigation to any screen under the app shell while the
// server component streams. The sidebar/header stay mounted and interactive.
export default function Loading() {
  return <PageLoader />;
}
