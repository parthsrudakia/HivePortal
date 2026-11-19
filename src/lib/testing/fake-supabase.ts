/**
 * In-memory stand-in for the slice of the supabase-js query builder that the
 * application-invite modules use (no joins, no RPCs). Tests only.
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type FakeRow = Record<string, unknown>;
type Filter = (row: FakeRow) => boolean;

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function opFilter(col: string, op: string, value: string): Filter {
  switch (op) {
    case "is":
      return (r) => (value === "null" ? (r[col] ?? null) === null : r[col] === value);
    case "eq":
      return (r) => String(r[col]) === value;
    case "lt":
      return (r) => r[col] != null && cmp(r[col], value) < 0;
    case "gt":
      return (r) => r[col] != null && cmp(r[col], value) > 0;
    case "gte":
      return (r) => r[col] != null && cmp(r[col], value) >= 0;
    default:
      throw new Error(`fake supabase: unsupported or() operator ${op}`);
  }
}

class Query implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private filters: Filter[] = [];
  private values: FakeRow | FakeRow[] = {};
  private returning = false;
  private mode: "many" | "single" | "maybe" = "many";
  private sort: { col: string; asc: boolean } | null = null;
  private max: number | null = null;

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select(cols?: string) {
    void cols;
    if (this.op !== "select") this.returning = true;
    return this;
  }
  insert(values: FakeRow | FakeRow[]) {
    this.op = "insert";
    this.values = values;
    return this;
  }
  update(values: FakeRow) {
    this.op = "update";
    this.values = values;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((r) => r[col] === v);
    return this;
  }
  is(col: string, v: null) {
    this.filters.push((r) => (r[col] ?? null) === v);
    return this;
  }
  not(col: string, op: string, v: unknown) {
    if (op !== "is") throw new Error(`fake supabase: unsupported not(${op})`);
    this.filters.push((r) => (r[col] ?? null) !== v);
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[col]));
    return this;
  }
  lt(col: string, v: unknown) {
    this.filters.push((r) => r[col] != null && cmp(r[col], v) < 0);
    return this;
  }
  gt(col: string, v: unknown) {
    this.filters.push((r) => r[col] != null && cmp(r[col], v) > 0);
    return this;
  }
  gte(col: string, v: unknown) {
    this.filters.push((r) => r[col] != null && cmp(r[col], v) >= 0);
    return this;
  }
  /** "a.is.null,b.lt.2026-01-01T00:00:00.000Z": any branch matches. */
  or(expr: string) {
    const branches = expr.split(",").map((part) => {
      const first = part.indexOf(".");
      const second = part.indexOf(".", first + 1);
      return opFilter(part.slice(0, first), part.slice(first + 1, second), part.slice(second + 1));
    });
    this.filters.push((r) => branches.some((f) => f(r)));
    return this;
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.sort = { col, asc: opts.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  returns() {
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }

  private run(): { data: unknown; error: { message: string } | null } {
    const rows = (this.db.tables[this.table] ??= []);
    const failure = this.db.failNext[`${this.table}:${this.op}`];
    if (failure) {
      delete this.db.failNext[`${this.table}:${this.op}`];
      return { data: null, error: { message: failure } };
    }
    let out: FakeRow[];
    if (this.op === "insert") {
      const list = Array.isArray(this.values) ? this.values : [this.values];
      out = list.map((v) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...v }));
      rows.push(...out);
      if (!this.returning) return { data: null, error: null };
    } else {
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        for (const r of hit) Object.assign(r, this.values);
        if (!this.returning) return { data: null, error: null };
      } else if (this.op === "delete") {
        this.db.tables[this.table] = rows.filter((r) => !hit.includes(r));
        if (!this.returning) return { data: null, error: null };
      }
      out = hit;
    }
    if (this.sort) {
      const { col, asc } = this.sort;
      out = [...out].sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
    }
    if (this.max != null) out = out.slice(0, this.max);
    const copies = out.map((r) => ({ ...r }));
    if (this.mode === "many") return { data: copies, error: null };
    if (this.mode === "single" && copies.length !== 1) {
      return { data: null, error: { message: `expected one row, got ${copies.length}` } };
    }
    return { data: copies[0] ?? null, error: null };
  }

  then<A = { data: unknown; error: { message: string } | null }, B = never>(
    onFulfilled?: ((v: { data: unknown; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    // Resolve on a later tick so concurrent callers interleave like real I/O.
    return new Promise<{ data: unknown; error: { message: string } | null }>((resolve) =>
      setTimeout(() => resolve(this.run()), 0),
    ).then(onFulfilled, onRejected);
  }
}

export class FakeDb {
  tables: Record<string, FakeRow[]>;
  /** "table:op" → error message returned by the next such call. */
  failNext: Record<string, string> = {};

  constructor(tables: Record<string, FakeRow[]> = {}) {
    this.tables = tables;
  }

  client(): SupabaseClient {
    return { from: (table: string) => new Query(this, table) } as unknown as SupabaseClient;
  }

  rows(table: string): FakeRow[] {
    return this.tables[table] ?? [];
  }
}
