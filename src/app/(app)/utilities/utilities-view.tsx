"use client";

import { useMemo, useState } from "react";
import { billMonth, filterBills, type BillRow, type UnitOpt } from "./bill-utils";
import { MonthlyChart } from "./monthly-chart";
import { UploadForm } from "./upload-form";
import { BillsLog } from "./bills-log";

/**
 * Client shell for /utilities: owns the filter state so the chart, the
 * upload section, and the log all reflect the same unit / over-$200 view.
 */
export function UtilitiesView({
  bills,
  units,
  canCharge,
  billTenants,
}: {
  bills: BillRow[];
  units: UnitOpt[];
  /** Ledger-admin only: posting/unposting overage charges to tenants. */
  canCharge: boolean;
  /** Per over-$200 bill: first names of the tenants sharing the overage. */
  billTenants: Record<string, string[]>;
}) {
  const [filter, setFilter] = useState("");
  const [overOnly, setOverOnly] = useState(false);
  const [chargedOnly, setChargedOnly] = useState(false);

  const visible = useMemo(
    () => filterBills(bills, filter, overOnly, chargedOnly),
    [bills, filter, overOnly, chargedOnly],
  );

  const series = useMemo(() => {
    const byMonth = new Map<string, number>();
    for (const b of visible) {
      const m = billMonth(b);
      byMonth.set(m, (byMonth.get(m) ?? 0) + Number(b.total_amount));
    }
    return [...byMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, total]) => ({ month, total }));
  }, [visible]);

  return (
    <>
      {series.length > 0 && (
        <section className="mt-8">
          <MonthlyChart data={series} />
        </section>
      )}

      <section className="mt-6">
        <UploadForm />
      </section>

      <section className="mt-10">
        <BillsLog
          bills={bills}
          units={units}
          filter={filter}
          setFilter={setFilter}
          overOnly={overOnly}
          setOverOnly={setOverOnly}
          chargedOnly={chargedOnly}
          setChargedOnly={setChargedOnly}
          canCharge={canCharge}
          billTenants={billTenants}
        />
      </section>
    </>
  );
}
