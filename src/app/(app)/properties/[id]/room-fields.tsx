"use client";

type Initial = {
  base_rent?: number | null;
  bundle_fee?: number | null;
  status?: "occupied" | "available" | "reserved" | "maintenance";
  available_from?: string | null;
  has_private_bathroom?: boolean | null;
  notes?: string | null;
  marketing_description?: string | null;
  photos_url?: string | null;
};

const fieldLabel =
  "text-xs font-medium uppercase tracking-wide text-muted";
const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";
const checkboxLabel =
  "flex items-center gap-2 text-sm text-ink";

export function RoomFields({
  initial,
  showStatus = true,
}: {
  initial?: Initial;
  // New rooms are always created "available", so the add form hides this.
  showStatus?: boolean;
}) {
  const v = initial ?? {};
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {showStatus && (
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Status</span>
          <select
            name="status"
            defaultValue={v.status ?? "available"}
            className={fieldInput}
          >
            <option value="available">Available</option>
            <option value="occupied">Occupied</option>
            <option value="reserved">Reserved</option>
            <option value="maintenance">Maintenance</option>
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Base rent ($)</span>
        <input
          type="number"
          name="base_rent"
          min="0"
          step="1"
          defaultValue={v.base_rent ?? ""}
          className={fieldInput}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Services ($)</span>
        <input
          type="number"
          name="bundle_fee"
          min="0"
          step="1"
          defaultValue={v.bundle_fee ?? 125}
          className={fieldInput}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Available from</span>
        <input
          type="date"
          name="available_from"
          defaultValue={v.available_from ?? ""}
          className={fieldInput}
        />
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
        <label className={checkboxLabel}>
          <input
            type="checkbox"
            name="has_private_bathroom"
            defaultChecked={v.has_private_bathroom ?? false}
            className="accent-accent"
          />
          Private bathroom
        </label>
      </div>
      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className={fieldLabel}>Photos URL (Google Drive folder)</span>
        <input
          type="url"
          name="photos_url"
          defaultValue={v.photos_url ?? ""}
          placeholder="https://drive.google.com/…"
          className={fieldInput}
        />
      </label>
      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className={fieldLabel}>
          Listing description (paste-ready for marketing posts)
        </span>
        <textarea
          name="marketing_description"
          defaultValue={v.marketing_description ?? ""}
          rows={5}
          placeholder="e.g. Bright private room in a renovated 3BR in JSQ. Steps from PATH. Gym, laundry, doorman. Includes utilities + wi-fi + cleaning."
          className={`${fieldInput} resize-y`}
        />
      </label>
      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className={fieldLabel}>Internal notes (not for listing)</span>
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
