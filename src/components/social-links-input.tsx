"use client";

import { useState } from "react";

/**
 * Dynamic list of profile-link inputs, submitted as repeated
 * `social_links` form fields (read server-side with formData.getAll).
 * Used by the add-tenant form and the tenant profile editor.
 */
export function SocialLinksInput({
  initial = [],
  inputClassName = "",
}: {
  initial?: string[];
  inputClassName?: string;
}) {
  const [links, setLinks] = useState<string[]>(
    initial.length > 0 ? initial : [""],
  );

  return (
    <div className="flex flex-col gap-2">
      {links.map((link, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="url"
            name="social_links"
            value={link}
            onChange={(e) =>
              setLinks(links.map((l, j) => (j === i ? e.target.value : l)))
            }
            placeholder="https://linkedin.com/in/… or any profile URL"
            className={`min-w-0 flex-1 ${inputClassName}`}
          />
          {links.length > 1 && (
            <button
              type="button"
              aria-label="Remove link"
              onClick={() => setLinks(links.filter((_, j) => j !== i))}
              className="shrink-0 rounded-full px-2 text-sm text-muted hover:text-red-700"
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => setLinks([...links, ""])}
        className="self-start text-xs uppercase tracking-wide text-accent-text hover:text-accent-dark"
      >
        + Add another link
      </button>
    </div>
  );
}
