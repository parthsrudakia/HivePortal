/**
 * Test stand-in for one table behind PostgREST, for checking that reads get
 * every row past the server's response cap. Filters are accepted but not
 * applied (build the rows to match), every response holds at most ROW_CAP
 * rows like the real server, and an exact count comes back when asked for.
 */

/** PostgREST's max-rows: no single response holds more than this. */
export const ROW_CAP = 1000;

type Result = {
  data: unknown[] | null;
  error: { message: string } | null;
  count: number | null;
};

export function cappedTable(rows: unknown[], opts: { fail?: () => boolean } = {}) {
  let from = 0;
  let to = Infinity;
  let counted = false;
  const self = () => b;
  const b = {
    select: (_columns: string, o?: { count?: string }) => {
      counted = o?.count === "exact";
      return b;
    },
    eq: self,
    in: self,
    is: self,
    not: self,
    gte: self,
    lte: self,
    order: self,
    returns: self,
    range: (f: number, t: number) => {
      from = f;
      to = t;
      return b;
    },
    then: <R,>(resolve: (r: Result) => R) =>
      Promise.resolve<Result>(
        opts.fail?.()
          ? { data: null, error: { message: "504 gateway timeout" }, count: null }
          : {
              data: rows.slice(from, Math.min(to + 1, from + ROW_CAP)),
              error: null,
              count: counted ? rows.length : null,
            },
      ).then(resolve),
  };
  return b;
}

/** A client whose from(name) serves the given rows; unknown tables are empty. */
export function cappedClient(
  tables: Record<string, unknown[]>,
  fail?: (table: string) => boolean,
) {
  return {
    from: (name: string) =>
      cappedTable(tables[name] ?? [], { fail: fail && (() => fail(name)) }),
  };
}
