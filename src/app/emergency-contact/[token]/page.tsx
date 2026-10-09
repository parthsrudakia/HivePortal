import { notFound } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { one } from "@/lib/relations";
import { EmergencyContactForm } from "./emergency-contact-form";

export const dynamic = "force-dynamic";
// Token in the URL is the only credential; keep these pages out of search.
export const metadata = {
  title: "Emergency contact",
  description: "Add your emergency contact.",
  robots: { index: false, follow: false },
};

function admin() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

type PageProps = { params: Promise<{ token: string }> };

export default async function EmergencyContactPage({ params }: PageProps) {
  const { token } = await params;
  // Postgres rejects a malformed uuid with an error rather than no rows.
  if (!/^[0-9a-f-]{36}$/i.test(token)) notFound();

  const { data: row, error } = await admin()
    .from("emergency_contacts")
    .select(
      "contact_name, relationship, contact_email, contact_phone, submitted_at, tenants(full_name)",
    )
    .eq("token", token)
    .maybeSingle();
  if (error) throw error;
  if (!row) notFound();

  const fullName = one(row.tenants)?.full_name ?? "";
  const firstName = fullName.split(/\s+/)[0] || "there";

  return (
    <main className="min-h-screen bg-cream px-4 py-10 sm:py-16">
      <div className="mx-auto w-full max-w-lg">
        <header className="text-center">
          <p className="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-accent-text">
            Hive
          </p>
          <h1 className="text-3xl tracking-tight text-ink">
            Emergency{" "}
            <span className="font-display italic text-accent-text">contact</span>
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Hi {firstName}, please tell us who we should reach if something
            happens. All fields are required, and this is only used in an
            emergency.
          </p>
        </header>

        <section className="mt-8 rounded-2xl bg-white p-6 shadow-sm sm:p-8">
          <EmergencyContactForm
            token={token}
            initial={{
              contactName: row.contact_name ?? "",
              relationship: row.relationship ?? "",
              contactEmail: row.contact_email ?? "",
              contactPhone: row.contact_phone ?? "",
            }}
            alreadySubmitted={row.submitted_at !== null}
          />
        </section>
      </div>
    </main>
  );
}
