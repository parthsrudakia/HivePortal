"use client";

import type { Database } from "@/lib/supabase/types";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type PropertyOption,
} from "./constants";

type Category = Database["public"]["Enums"]["credential_category"];

type Initial = {
  category?: Category;
  service_name?: string | null;
  property_id?: string | null;
  username?: string | null;
  password?: string | null;
  login_url?: string | null;
  account_number?: string | null;
  owner_label?: string | null;
  notes?: string | null;
};

const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";
const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";

export function CredentialFields({
  initial,
  properties,
  hidePassword = false,
}: {
  initial?: Initial;
  properties: PropertyOption[];
  // Non-admins can edit other fields but must not see (or overwrite) the
  // password. The server also strips it from their updates as a backstop.
  hidePassword?: boolean;
}) {
  const v = initial ?? {};
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Category *</span>
        <select
          name="category"
          defaultValue={v.category ?? "payment_portal"}
          required
          className={fieldInput}
        >
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Service name *</span>
        <input
          type="text"
          name="service_name"
          defaultValue={v.service_name ?? ""}
          placeholder="Spectrum, ClickPay, BoA, Aircall…"
          required
          className={fieldInput}
        />
      </label>
      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className={fieldLabel}>Property (leave blank for general/account-level)</span>
        <select
          name="property_id"
          defaultValue={v.property_id ?? ""}
          className={fieldInput}
        >
          <option value="">— None (general) —</option>
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Username</span>
        <input
          type="text"
          name="username"
          defaultValue={v.username ?? ""}
          autoComplete="off"
          className={fieldInput}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Password</span>
        {hidePassword ? (
          <input
            type="text"
            value="•••••••• (admin only)"
            disabled
            className={`${fieldInput} cursor-not-allowed text-muted`}
          />
        ) : (
          <input
            type="text"
            name="password"
            defaultValue={v.password ?? ""}
            autoComplete="off"
            className={fieldInput}
          />
        )}
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Login URL</span>
        <input
          type="url"
          name="login_url"
          defaultValue={v.login_url ?? ""}
          placeholder="https://…"
          className={fieldInput}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Account number</span>
        <input
          type="text"
          name="account_number"
          defaultValue={v.account_number ?? ""}
          className={fieldInput}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Owner / under whose name</span>
        <input
          type="text"
          name="owner_label"
          defaultValue={v.owner_label ?? ""}
          placeholder="vdutta1485@hotmail.com"
          className={fieldInput}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Notes</span>
        <input
          type="text"
          name="notes"
          defaultValue={v.notes ?? ""}
          className={fieldInput}
        />
      </label>
    </div>
  );
}
