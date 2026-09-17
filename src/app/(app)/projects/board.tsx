"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { useHydrated } from "@/lib/use-hydrated";
import type { BoardStatus } from "@/lib/board";
import type { TaskWithComments } from "./page";
import {
  addComment,
  approveTask,
  clearCompleted,
  createTask,
  deleteTask,
  markSeen,
  rejectTask,
  sendNudge,
  toggleAttention,
  updateDeadline,
  updateStatus,
  type BoardActionState,
} from "./actions";

export type BoardComment = {
  id: string;
  author: string | null;
  author_label: string | null;
  text: string;
  created_at: string;
};

type Member = { id: string; name: string; isAdmin: boolean };

type View =
  | "overview"
  | "tasks"
  | "review"
  | "attention"
  | "completed"
  | "calendar";

type SortKey = "default" | "deadline" | "status" | "urgent";

// ── Shared bits ──────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<BoardStatus, string> = {
  "not started": "bg-red-50 text-red-800 border-red-200",
  "in progress": "bg-blue-50 text-blue-800 border-blue-200",
  pending_review: "bg-amber-50 text-amber-800 border-amber-200",
  completed: "bg-emerald-50 text-emerald-800 border-emerald-200",
};
const STATUS_DOT: Record<BoardStatus, string> = {
  "not started": "bg-red-600",
  "in progress": "bg-blue-700",
  pending_review: "bg-amber-500",
  completed: "bg-emerald-600",
};
const STATUS_LABEL: Record<BoardStatus, string> = {
  "not started": "Not started",
  "in progress": "In progress",
  pending_review: "Pending review",
  completed: "Completed",
};
const STATUS_ORDER: Record<BoardStatus, number> = {
  "not started": 0,
  "in progress": 1,
  pending_review: 2,
  completed: 3,
};

function daysUntil(deadline: string | null): number | null {
  if (!deadline) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${deadline}T00:00:00`);
  return Math.ceil((d.getTime() - today.getTime()) / 86400000);
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function deadlineChip(deadline: string | null): {
  text: string;
  cls: string;
} | null {
  const days = daysUntil(deadline);
  if (days === null) return null;
  if (days < 0)
    return { text: `${fmtDate(deadline)} · ${-days}d overdue`, cls: "text-red-700 font-semibold" };
  if (days === 0) return { text: `${fmtDate(deadline)} · due today`, cls: "text-red-700 font-semibold" };
  if (days === 1) return { text: `${fmtDate(deadline)} · 1 day left`, cls: "text-red-700 font-semibold" };
  if (days <= 3) return { text: `${fmtDate(deadline)} · ${days} days left`, cls: "text-amber-700" };
  return { text: `${fmtDate(deadline)} · ${days} days left`, cls: "text-muted" };
}

function isOverdue(t: TaskWithComments): boolean {
  const d = daysUntil(t.deadline);
  return (
    t.status !== "completed" &&
    t.status !== "pending_review" &&
    d !== null &&
    d < 0
  );
}

const ordinal = (n: number) =>
  `${n}${["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4] ?? "th"}`;

function report(r: BoardActionState) {
  if (r?.error) toast.error(r.error);
  else if (r?.success) toast.success(r.success);
}

function StatusPill({ status }: { status: BoardStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}

// ── Main board ───────────────────────────────────────────────────────────────

export function ProjectsBoard({
  tasks,
  members,
  meId,
  admin,
}: {
  tasks: TaskWithComments[];
  members: Member[];
  meId: string;
  admin: boolean;
}) {
  const [view, setView] = useState<View>(admin ? "overview" : "tasks");
  const [sort, setSort] = useState<SortKey>("default");
  const [filterMember, setFilterMember] = useState<string>("");
  const [overviewFilter, setOverviewFilter] = useState<string>("");
  const [selected, setSelected] = useState<TaskWithComments | null>(null);
  const [creating, setCreating] = useState(false);

  const memberName = (id: string | null, label?: string | null) =>
    members.find((m) => m.id === id)?.name ?? label ?? "—";

  const mine = admin ? tasks : tasks.filter((t) => t.assigned_to === meId);
  const scoped =
    admin && filterMember
      ? mine.filter((t) => t.assigned_to === filterMember)
      : mine;

  const pendingCount = tasks.filter((t) => t.status === "pending_review").length;
  const attentionCount = tasks.filter((t) => t.needs_attention).length;

  // Admin heads-up popups, once per browser session on opening the tab:
  // flagged tasks first, then pending reviews after that one is dismissed.
  // Initialized on the first post-hydration render (a guarded render-time
  // state adjustment); the session mark itself is written in the effect.
  const hydrated = useHydrated();
  const [popup, setPopup] = useState<"attention" | "review" | null>(null);
  const [popupQueue, setPopupQueue] = useState<"review" | null>(null);
  const [popupsInitialized, setPopupsInitialized] = useState(false);
  if (hydrated && !popupsInitialized) {
    setPopupsInitialized(true);
    if (admin && !sessionStorage.getItem("hive-projects-popups")) {
      if (attentionCount > 0) {
        setPopup("attention");
        if (pendingCount > 0) setPopupQueue("review");
      } else if (pendingCount > 0) {
        setPopup("review");
      }
    }
  }
  useEffect(() => {
    if (hydrated && admin) sessionStorage.setItem("hive-projects-popups", "1");
  }, [hydrated, admin]);
  const dismissPopup = () => {
    setPopup(popupQueue);
    setPopupQueue(null);
  };

  const sortFn = (a: TaskWithComments, b: TaskWithComments): number => {
    if (sort === "deadline") {
      if (!a.deadline && !b.deadline) return 0;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return a.deadline.localeCompare(b.deadline);
    }
    if (sort === "status") {
      const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (d !== 0) return d;
    }
    if (sort === "urgent" || sort === "default") {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
    }
    return b.created_at.localeCompare(a.created_at);
  };

  // Keep the modal's task fresh after server revalidation.
  const selectedFresh = selected
    ? tasks.find((t) => t.id === selected.id) ?? null
    : null;

  const tabs: { key: View; label: string; badge?: number; adminOnly?: boolean }[] = [
    { key: "overview", label: "Overview", adminOnly: true },
    { key: "tasks", label: admin ? "All Projects" : "My Projects" },
    { key: "review", label: "Pending Review", badge: pendingCount, adminOnly: true },
    { key: "attention", label: "Needs Attention", badge: attentionCount, adminOnly: true },
    { key: "completed", label: "Completed" },
    { key: "calendar", label: "Calendar" },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone/60 pb-6">
        <div>
          <h1 className="text-3xl tracking-tight text-ink">
            <span className="font-display text-accent-text">Projects</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Team projects, reviews, and deadlines.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark"
        >
          + New Project
        </button>
      </header>

      <nav className="mt-6 flex flex-wrap gap-2">
        {tabs
          .filter((t) => !t.adminOnly || admin)
          .map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setView(t.key);
                setOverviewFilter("");
              }}
              className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-sm transition ${
                view === t.key
                  ? "bg-ink text-white"
                  : "border border-stone bg-white text-ink hover:bg-warm"
              }`}
            >
              {t.label}
              {!!t.badge && (
                <span className="rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white">
                  {t.badge > 99 ? "99+" : t.badge}
                </span>
              )}
            </button>
          ))}
      </nav>

      <div className="mt-8">
        {view === "overview" && admin && (
          <OverviewView
            tasks={tasks}
            members={members}
            filter={overviewFilter}
            setFilter={setOverviewFilter}
            onOpen={setSelected}
            onMember={(id) => {
              setFilterMember(id);
              setView("tasks");
            }}
            memberName={memberName}
          />
        )}

        {view === "tasks" && (
          <TaskListView
            tasks={scoped.filter(
              (t) => t.status !== "completed" && t.status !== "pending_review",
            )}
            admin={admin}
            meId={meId}
            members={members}
            sort={sort}
            setSort={setSort}
            filterMember={filterMember}
            setFilterMember={setFilterMember}
            sortFn={sortFn}
            onOpen={setSelected}
            memberName={memberName}
          />
        )}

        {view === "review" && admin && (
          <ReviewView
            tasks={tasks.filter((t) => t.status === "pending_review")}
            onOpen={setSelected}
            memberName={memberName}
          />
        )}

        {view === "attention" && admin && (
          <AttentionView
            tasks={tasks.filter((t) => t.needs_attention)}
            onOpen={setSelected}
            memberName={memberName}
          />
        )}

        {view === "completed" && (
          <CompletedView
            tasks={scoped.filter((t) => t.status === "completed")}
            admin={admin}
            onOpen={setSelected}
            memberName={memberName}
          />
        )}

        {view === "calendar" && (
          <CalendarView
            tasks={scoped}
            admin={admin}
            members={members}
            filterMember={filterMember}
            setFilterMember={setFilterMember}
            onOpen={setSelected}
            memberName={memberName}
          />
        )}
      </div>

      {popup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-white p-7 shadow-xl">
            <h2 className="text-xl tracking-tight text-ink">
              {popup === "attention" ? (
                <>🔔 Needs your <span className="font-display text-accent-text">attention</span></>
              ) : (
                <>Pending <span className="font-display text-accent-text">reviews</span></>
              )}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {popup === "attention"
                ? `${attentionCount} project${attentionCount === 1 ? " has" : "s have"} been flagged by your team members.`
                : `${pendingCount} project${pendingCount === 1 ? " has" : "s have"} been submitted for your review.`}
            </p>
            <ul className="mt-3 flex flex-col gap-1.5 text-sm text-ink/80">
              {tasks
                .filter((t) =>
                  popup === "attention"
                    ? t.needs_attention
                    : t.status === "pending_review",
                )
                .slice(0, 3)
                .map((t) => (
                  <li key={t.id} className="truncate rounded-lg bg-warm/50 px-3 py-1.5">
                    {t.title}
                  </li>
                ))}
            </ul>
            {(popup === "attention" ? attentionCount : pendingCount) > 3 && (
              <p className="mt-1.5 text-xs text-muted">
                +{(popup === "attention" ? attentionCount : pendingCount) - 3} more
              </p>
            )}
            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setView(popup === "attention" ? "attention" : "review");
                  dismissPopup();
                }}
                className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark"
              >
                {popup === "attention" ? "View all" : "Review now"}
              </button>
              <button
                type="button"
                onClick={dismissPopup}
                className="text-xs uppercase tracking-wide text-muted hover:text-ink"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedFresh && (
        <TaskModal
          task={selectedFresh}
          admin={admin}
          meId={meId}
          memberName={memberName}
          onClose={() => setSelected(null)}
        />
      )}
      {creating && (
        <CreateModal
          admin={admin}
          meId={meId}
          members={members}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

// ── Task card ────────────────────────────────────────────────────────────────

function TaskCard({
  task,
  admin,
  meId,
  onOpen,
  memberName,
  footer,
}: {
  task: TaskWithComments;
  admin: boolean;
  meId: string;
  onOpen: (t: TaskWithComments) => void;
  memberName: (id: string | null, label?: string | null) => string;
  footer?: React.ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  const chip = deadlineChip(task.deadline);
  const isNew = !admin && task.assigned_to === meId && !task.seen_by_assignee;
  const nudgeable =
    admin && task.status !== "completed" && task.status !== "pending_review";

  return (
    <div
      className={`cursor-pointer rounded-2xl bg-white p-5 shadow-sm transition hover:shadow ${
        task.urgent ? "border-l-2 border-red-600" : ""
      } ${isNew ? "ring-1 ring-accent/40" : ""}`}
      onClick={() => {
        if (isNew) markSeen(task.id);
        onOpen(task);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={task.status} />
        {task.urgent && (
          <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
            Urgent
          </span>
        )}
        {task.needs_attention && (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
            🔔 Needs attention
          </span>
        )}
        {task.recurring && (
          <span className="rounded-full border border-stone bg-warm px-2 py-0.5 text-[11px] text-ink/70">
            Monthly · {ordinal(task.recurring_day ?? 1)}
          </span>
        )}
        {isNew && (
          <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase text-white">
            New
          </span>
        )}
        <span className="ml-auto text-xs text-muted">#{task.seq}</span>
      </div>
      <h3 className="mt-2 text-base text-ink">{task.title}</h3>
      {task.description && (
        <p className="mt-1 line-clamp-2 text-sm text-muted">{task.description}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="text-muted">
          {memberName(task.assigned_to, task.assigned_label)}
        </span>
        <span className="text-muted">
          💬 {task.board_comments?.length ?? 0}
        </span>
        {chip && <span className={chip.cls}>{chip.text}</span>}
        {nudgeable && (
          <button
            type="button"
            disabled={pending} aria-busy={pending}
            onClick={(e) => {
              e.stopPropagation();
              startTransition(async () => report(await sendNudge(task.id)));
            }}
            className="ml-auto rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            📣 Nudge
          </button>
        )}
      </div>
      {footer}
    </div>
  );
}

// ── Views ────────────────────────────────────────────────────────────────────

function EmptyState({ icon, label }: { icon: string; label: string }) {
  return (
    <p className="rounded-2xl bg-white px-6 py-14 text-center text-sm text-muted shadow-sm">
      <span className="mb-2 block text-3xl">{icon}</span>
      {label}
    </p>
  );
}

function OverviewView({
  tasks,
  members,
  filter,
  setFilter,
  onOpen,
  onMember,
  memberName,
}: {
  tasks: TaskWithComments[];
  members: Member[];
  filter: string;
  setFilter: (f: string) => void;
  onOpen: (t: TaskWithComments) => void;
  onMember: (id: string) => void;
  memberName: (id: string | null, label?: string | null) => string;
}) {
  const [pending, startTransition] = useTransition();
  const stats: { key: string; label: string; match: (t: TaskWithComments) => boolean }[] = [
    { key: "all", label: "Total", match: () => true },
    { key: "overdue", label: "Overdue", match: isOverdue },
    { key: "not started", label: "Not started", match: (t) => t.status === "not started" },
    { key: "in progress", label: "In progress", match: (t) => t.status === "in progress" },
    { key: "pending_review", label: "Pending review", match: (t) => t.status === "pending_review" },
    { key: "completed", label: "Completed", match: (t) => t.status === "completed" },
    { key: "urgent", label: "Urgent", match: (t) => t.urgent },
  ];
  const active = stats.find((s) => s.key === filter);

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {stats.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setFilter(filter === s.key ? "" : s.key)}
            className={`rounded-2xl p-4 text-left shadow-sm transition ${
              filter === s.key ? "bg-ink text-white" : "bg-white hover:shadow"
            }`}
          >
            <div className="text-3xl font-semibold tabular-nums">
              {tasks.filter(s.match).length}
            </div>
            <div
              className={`mt-1 text-[10px] font-medium uppercase tracking-wide ${
                filter === s.key ? "text-white/70" : "text-muted"
              }`}
            >
              {s.label}
            </div>
          </button>
        ))}
      </div>

      {active ? (
        <div className="mt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
              {active.label} ({tasks.filter(active.match).length})
            </h2>
            {filter === "completed" && tasks.some((t) => t.status === "completed") && (
              <button
                type="button"
                disabled={pending} aria-busy={pending}
                onClick={() => {
                  if (confirm("Delete ALL completed projects? This cannot be undone."))
                    startTransition(async () => report(await clearCompleted()));
                }}
                className="rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
              >
                Clear All
              </button>
            )}
          </div>
          <div className="mt-3 flex flex-col gap-3">
            {tasks.filter(active.match).map((t) => (
              <TaskCard key={t.id} task={t} admin meId="" onOpen={onOpen} memberName={memberName} />
            ))}
            {tasks.filter(active.match).length === 0 && (
              <EmptyState icon="🎉" label="Nothing here." />
            )}
          </div>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {members
            .filter((m) => !m.isAdmin)
            .map((m) => {
              const theirs = tasks.filter((t) => t.assigned_to === m.id);
              const done = theirs.filter((t) => t.status === "completed").length;
              const pct = theirs.length
                ? Math.round((done / theirs.length) * 100)
                : 0;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onMember(m.id)}
                  className="rounded-2xl bg-white p-5 text-left shadow-sm transition hover:shadow"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-ink">{m.name}</span>
                    <span className="text-xs tabular-nums text-muted">
                      {done}/{theirs.length} · {pct}%
                    </span>
                  </div>
                  <div className="mt-3 h-1 overflow-hidden rounded-full bg-warm">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
                    {(["not started", "in progress", "pending_review"] as BoardStatus[]).map(
                      (s) => {
                        const n = theirs.filter((t) => t.status === s).length;
                        return n > 0 ? (
                          <span key={s} className={`rounded-full border px-2 py-0.5 ${STATUS_STYLE[s]}`}>
                            {n} {STATUS_LABEL[s].toLowerCase()}
                          </span>
                        ) : null;
                      },
                    )}
                    {/* Only urgent tasks still in flight — a completed task
                        (review approved) is no longer a fire to flag. */}
                    {theirs.some((t) => t.urgent && t.status !== "completed") && (
                      <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-red-700">
                        {
                          theirs.filter(
                            (t) => t.urgent && t.status !== "completed",
                          ).length
                        }{" "}
                        urgent
                      </span>
                    )}
                  </div>
                  <div className="mt-3 text-xs text-accent-text">View projects →</div>
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}

function TaskListView({
  tasks,
  admin,
  meId,
  members,
  sort,
  setSort,
  filterMember,
  setFilterMember,
  sortFn,
  onOpen,
  memberName,
}: {
  tasks: TaskWithComments[];
  admin: boolean;
  meId: string;
  members: Member[];
  sort: SortKey;
  setSort: (s: SortKey) => void;
  filterMember: string;
  setFilterMember: (m: string) => void;
  sortFn: (a: TaskWithComments, b: TaskWithComments) => number;
  onOpen: (t: TaskWithComments) => void;
  memberName: (id: string | null, label?: string | null) => string;
}) {
  const sorted = useMemo(() => [...tasks].sort(sortFn), [tasks, sortFn]);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted">
          {tasks.length} active project{tasks.length === 1 ? "" : "s"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {admin && (
            <select
              value={filterMember}
              onChange={(e) => setFilterMember(e.target.value)}
              className="rounded-lg border border-stone bg-white px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
            >
              <option value="">All members</option>
              {members
                .filter((m) => !m.isAdmin)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          )}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-lg border border-stone bg-white px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
          >
            <option value="default">Sort: Default</option>
            <option value="deadline">Sort: Deadline</option>
            <option value="status">Sort: Status</option>
            <option value="urgent">Sort: Urgent first</option>
          </select>
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-3">
        {sorted.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            admin={admin}
            meId={meId}
            onOpen={onOpen}
            memberName={memberName}
          />
        ))}
        {sorted.length === 0 && (
          <EmptyState icon="🎉" label="All caught up! No active projects." />
        )}
      </div>
    </div>
  );
}

function ReviewView({
  tasks,
  onOpen,
  memberName,
}: {
  tasks: TaskWithComments[];
  onOpen: (t: TaskWithComments) => void;
  memberName: (id: string | null, label?: string | null) => string;
}) {
  return (
    <div>
      <p className="text-sm text-muted">
        {tasks.length} project{tasks.length === 1 ? "" : "s"} awaiting your review
      </p>
      <div className="mt-4 flex flex-col gap-3">
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            admin
            meId=""
            onOpen={onOpen}
            memberName={memberName}
            footer={<ReviewFooter task={t} memberName={memberName} />}
          />
        ))}
        {tasks.length === 0 && (
          <EmptyState icon="✅" label="No projects pending review." />
        )}
      </div>
    </div>
  );
}

function ReviewFooter({
  task,
  memberName,
}: {
  task: TaskWithComments;
  memberName: (id: string | null, label?: string | null) => string;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <div
      className="mt-4 border-t border-stone/40 pt-3"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Submitted by {memberName(task.assigned_to, task.assigned_label)}</span>
        <div className="ml-auto flex items-center gap-2">
          {!rejecting ? (
            <>
              <button
                type="button"
                disabled={pending} aria-busy={pending}
                onClick={() =>
                  startTransition(async () => report(await approveTask(task.id)))
                }
                className="rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
              >
                ✓ Approve
              </button>
              <button
                type="button"
                onClick={() => setRejecting(true)}
                className="rounded-full border border-red-200 bg-red-50 px-3 py-1 font-semibold text-red-700 hover:bg-red-100"
              >
                ✕ Reject
              </button>
            </>
          ) : (
            <>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (optional)"
                className="w-48 rounded-lg border border-stone bg-white px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                disabled={pending} aria-busy={pending}
                onClick={() =>
                  startTransition(async () => {
                    report(await rejectTask(task.id, reason));
                    setRejecting(false);
                    setReason("");
                  })
                }
                className="rounded-full border border-red-200 bg-red-50 px-3 py-1 font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
              >
                Confirm Reject
              </button>
              <button
                type="button"
                onClick={() => setRejecting(false)}
                className="text-muted hover:text-ink"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AttentionView({
  tasks,
  onOpen,
  memberName,
}: {
  tasks: TaskWithComments[];
  onOpen: (t: TaskWithComments) => void;
  memberName: (id: string | null, label?: string | null) => string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          {tasks.length} project{tasks.length === 1 ? "" : "s"} flagged by members
        </p>
        {tasks.length > 1 && (
          <button
            type="button"
            disabled={pending} aria-busy={pending}
            onClick={() =>
              startTransition(async () => {
                for (const t of tasks) await toggleAttention(t.id, false);
                toast.success("All flags dismissed.");
              })
            }
            className="rounded-full border border-stone bg-white px-3 py-1 text-xs text-ink hover:bg-warm"
          >
            ✓ Dismiss All
          </button>
        )}
      </div>
      <div className="mt-4 flex flex-col gap-3">
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            admin
            meId=""
            onOpen={onOpen}
            memberName={memberName}
            footer={
              <div
                className="mt-4 flex items-center justify-between border-t border-stone/40 pt-3 text-xs"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-amber-800">🔔 Flagged for your attention</span>
                <button
                  type="button"
                  disabled={pending} aria-busy={pending}
                  onClick={() =>
                    startTransition(async () =>
                      report(await toggleAttention(t.id, false)),
                    )
                  }
                  className="rounded-full border border-stone bg-white px-3 py-1 font-medium text-ink hover:bg-warm disabled:opacity-50"
                >
                  ✓ Dismiss
                </button>
              </div>
            }
          />
        ))}
        {tasks.length === 0 && (
          <EmptyState icon="✅" label="No projects need your attention." />
        )}
      </div>
    </div>
  );
}

function CompletedView({
  tasks,
  admin,
  onOpen,
  memberName,
}: {
  tasks: TaskWithComments[];
  admin: boolean;
  onOpen: (t: TaskWithComments) => void;
  memberName: (id: string | null, label?: string | null) => string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          {tasks.length} completed project{tasks.length === 1 ? "" : "s"}
        </p>
        {admin && tasks.length > 0 && (
          <button
            type="button"
            disabled={pending} aria-busy={pending}
            onClick={() => {
              if (confirm("Delete ALL completed projects? This cannot be undone."))
                startTransition(async () => report(await clearCompleted()));
            }}
            className="rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
          >
            Clear All
          </button>
        )}
      </div>
      <div className="mt-4 flex flex-col gap-3">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} admin={admin} meId="" onOpen={onOpen} memberName={memberName} />
        ))}
        {tasks.length === 0 && (
          <EmptyState icon="📭" label="No completed projects yet." />
        )}
      </div>
    </div>
  );
}

// ── Calendar ─────────────────────────────────────────────────────────────────

function CalendarView({
  tasks,
  admin,
  members,
  filterMember,
  setFilterMember,
  onOpen,
  memberName,
}: {
  tasks: TaskWithComments[];
  admin: boolean;
  members: Member[];
  filterMember: string;
  setFilterMember: (m: string) => void;
  onOpen: (t: TaskWithComments) => void;
  memberName: (id: string | null, label?: string | null) => string;
}) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedDay, setSelectedDay] = useState<string>("");

  const withDeadline = tasks.filter((t) => {
    if (!t.deadline) return false;
    if (admin && filterMember && t.assigned_to !== filterMember) return false;
    if (statusFilter === "overdue") return isOverdue(t);
    if (statusFilter) return t.status === statusFilter;
    return true;
  });

  const byDay = new Map<string, TaskWithComments[]>();
  for (const t of withDeadline) {
    const k = t.deadline!.slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(t);
  }

  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const cells: { date: Date; iso: string; other: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - startOffset + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    cells.push({ date: d, iso, other: d.getMonth() !== month });
  }
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dayTasks = selectedDay
    ? (byDay.get(selectedDay) ?? []).sort((a, b) =>
        a.urgent !== b.urgent ? (a.urgent ? -1 : 1) : a.title.localeCompare(b.title),
      )
    : [];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setYear(now.getFullYear());
            setMonth(now.getMonth());
          }}
          className="rounded-full border border-stone bg-white px-3 py-1.5 text-xs text-ink hover:bg-warm"
        >
          Today
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => {
              const d = new Date(year, month - 1, 1);
              setYear(d.getFullYear());
              setMonth(d.getMonth());
            }}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-stone bg-white text-ink hover:bg-warm"
          >
            ‹
          </button>
          <span className="min-w-[160px] text-center text-xl tracking-tight text-ink">
            {first.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </span>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => {
              const d = new Date(year, month + 1, 1);
              setYear(d.getFullYear());
              setMonth(d.getMonth());
            }}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-stone bg-white text-ink hover:bg-warm"
          >
            ›
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {admin && (
            <select
              value={filterMember}
              onChange={(e) => setFilterMember(e.target.value)}
              className="rounded-lg border border-stone bg-white px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
            >
              <option value="">All members</option>
              {members
                .filter((m) => !m.isAdmin)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          )}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-stone bg-white px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
          >
            <option value="">All statuses</option>
            <option value="not started">Not started</option>
            <option value="in progress">In progress</option>
            <option value="pending_review">Pending review</option>
            <option value="completed">Completed</option>
            <option value="overdue">Overdue</option>
          </select>
        </div>
      </div>

      <p className="mt-2 text-xs text-muted">
        {withDeadline.length} project{withDeadline.length === 1 ? "" : "s"} with deadlines
      </p>

      <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-stone/40">
        <div className="grid grid-cols-7 border-b border-stone/40 bg-warm/60">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div
              key={d}
              className="px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-muted"
            >
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((c) => {
            const items = byDay.get(c.iso) ?? [];
            return (
              <button
                key={c.iso}
                type="button"
                onClick={() => setSelectedDay(c.iso)}
                className={`flex min-h-[72px] flex-col items-start gap-1 border-b border-r border-stone/30 p-1.5 text-left transition last:border-r-0 hover:bg-warm/50 md:min-h-[92px] ${
                  c.other ? "bg-cream/60" : "bg-white"
                } ${selectedDay === c.iso ? "ring-2 ring-inset ring-accent" : ""}`}
              >
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                    c.iso === todayIso
                      ? "bg-ink font-semibold text-white"
                      : c.other
                        ? "text-muted/60"
                        : "text-ink/80"
                  }`}
                >
                  {c.date.getDate()}
                </span>
                {items.slice(0, 2).map((t) => (
                  <span
                    key={t.id}
                    className="hidden w-full truncate rounded border-l-2 bg-warm/70 px-1 py-0.5 text-[10px] text-ink/80 md:block"
                    style={{
                      borderLeftColor:
                        t.status === "completed"
                          ? "#059669"
                          : t.status === "in progress"
                            ? "#1d4ed8"
                            : t.status === "pending_review"
                              ? "#d97706"
                              : "#dc2626",
                    }}
                  >
                    {t.title}
                  </span>
                ))}
                <span className="flex flex-wrap gap-0.5">
                  {items.slice(2, 8).map((t) => (
                    <span
                      key={t.id}
                      className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[t.status]}`}
                    />
                  ))}
                  {items.length > 3 && (
                    <span className="text-[9px] text-muted">+{items.length - 3}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {selectedDay && (
        <div className="mt-6">
          <h3 className="text-sm font-medium uppercase tracking-wide text-muted">
            {new Date(`${selectedDay}T12:00:00`).toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}{" "}
            · {dayTasks.length} project{dayTasks.length === 1 ? "" : "s"}
          </h3>
          <div className="mt-3 flex flex-col gap-3">
            {dayTasks.map((t) => (
              <TaskCard key={t.id} task={t} admin={admin} meId="" onOpen={onOpen} memberName={memberName} />
            ))}
            {dayTasks.length === 0 && (
              <p className="rounded-2xl border border-dashed border-stone px-6 py-8 text-center text-sm text-muted">
                No projects with deadlines on this day.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Task modal ───────────────────────────────────────────────────────────────

function TaskModal({
  task,
  admin,
  meId,
  memberName,
  onClose,
}: {
  task: TaskWithComments;
  admin: boolean;
  meId: string;
  memberName: (id: string | null, label?: string | null) => string;
  onClose: () => void;
}) {
  const [comment, setComment] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingDeadline, setEditingDeadline] = useState(false);
  const [deadlineVal, setDeadlineVal] = useState(task.deadline ?? "");
  const [pending, startTransition] = useTransition();
  const chip = deadlineChip(task.deadline);
  const isAssignee = task.assigned_to === meId;

  const memberStatuses: { label: string; value: BoardStatus }[] = task.recurring
    ? [
        { label: "not started", value: "not started" },
        { label: "in progress", value: "in progress" },
        { label: "completed", value: "completed" },
      ]
    : [
        { label: "not started", value: "not started" },
        { label: "in progress", value: "in progress" },
        { label: "submit for review", value: "pending_review" },
      ];

  function submitComment() {
    if (!comment.trim()) return;
    startTransition(async () => {
      report(await addComment(task.id, comment));
      setComment("");
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-7 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-xl tracking-tight text-ink">
            {task.urgent && (
              <span className="mr-2 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 align-middle text-[11px] font-medium text-red-700">
                Urgent
              </span>
            )}
            {task.title}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            {admin && !confirmDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
              >
                Delete
              </button>
            )}
            {admin && confirmDelete && (
              <>
                <button
                  type="button"
                  disabled={pending} aria-busy={pending}
                  onClick={() =>
                    startTransition(async () => {
                      report(await deleteTask(task.id));
                      onClose();
                    })
                  }
                  className="rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
                >
                  {pending ? "Deleting…" : "Yes, delete"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="text-xs text-muted hover:text-ink"
                >
                  Cancel
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-stone bg-white px-2.5 py-1 text-xs text-ink hover:bg-warm"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <StatusPill status={task.status} />
          <span className="rounded-full border border-stone bg-warm/60 px-2.5 py-0.5 text-ink/80">
            {memberName(task.assigned_to, task.assigned_label)}
          </span>
          {task.recurring ? (
            <span className="rounded-full border border-stone bg-warm px-2.5 py-0.5 text-ink/70">
              Monthly · {ordinal(task.recurring_day ?? 1)}
            </span>
          ) : admin ? (
            editingDeadline ? (
              <span className="flex items-center gap-2">
                <input
                  type="date"
                  value={deadlineVal}
                  onChange={(e) => setDeadlineVal(e.target.value)}
                  className="rounded-lg border border-accent bg-white px-2 py-1 text-xs text-ink focus:outline-none"
                />
                <button
                  type="button"
                  disabled={pending} aria-busy={pending}
                  onClick={() =>
                    startTransition(async () => {
                      report(await updateDeadline(task.id, deadlineVal || null));
                      setEditingDeadline(false);
                    })
                  }
                  className="rounded-full bg-ink px-3 py-1 text-xs font-medium text-white hover:bg-accent-dark"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingDeadline(false);
                    setDeadlineVal(task.deadline ?? "");
                  }}
                  className="text-muted hover:text-ink"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setEditingDeadline(true)}
                className={`rounded-full border border-stone bg-warm/60 px-2.5 py-0.5 hover:bg-warm ${chip?.cls ?? "text-muted"}`}
                title="Click to edit deadline"
              >
                {chip ? chip.text : "+ Set deadline"} ✎
              </button>
            )
          ) : (
            chip && (
              <span className={`rounded-full border border-stone bg-warm/60 px-2.5 py-0.5 ${chip.cls}`}>
                {chip.text}
              </span>
            )
          )}
        </div>

        {!admin && isAssignee && (
          <div className="mt-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Change status
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {memberStatuses.map((s) => {
                const active = task.status === s.value;
                return (
                  <button
                    key={s.value}
                    type="button"
                    disabled={pending || task.status === "pending_review"} aria-busy={pending}
                    onClick={() =>
                      startTransition(async () =>
                        report(await updateStatus(task.id, s.value)),
                      )
                    }
                    className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
                      active
                        ? STATUS_STYLE[s.value]
                        : "border-stone bg-white text-muted hover:bg-warm"
                    }`}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
            {task.status === "pending_review" && (
              <p className="mt-2 text-xs text-amber-800">
                Awaiting admin review. You&apos;ll be notified once reviewed.
              </p>
            )}
            {task.recurring && (
              <p className="mt-2 text-xs text-muted">
                Marking complete rolls this project to next month&apos;s deadline. No
                admin approval needed.
              </p>
            )}
          </div>
        )}

        {!admin && isAssignee && (
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={task.needs_attention}
              disabled={pending}
              onChange={(e) =>
                startTransition(async () => {
                  report(await toggleAttention(task.id, e.target.checked));
                  if (e.target.checked) toast.success("Admin has been notified ✓");
                })
              }
              className="accent-accent"
            />
            🔔 Needs admin attention
          </label>
        )}

        {admin && task.needs_attention && (
          <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <span className="text-sm font-medium text-amber-900">
              🔔 This project needs your attention
            </span>
            <button
              type="button"
              disabled={pending} aria-busy={pending}
              onClick={() =>
                startTransition(async () =>
                  report(await toggleAttention(task.id, false)),
                )
              }
              className="rounded-full border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
            >
              ✓ Dismiss
            </button>
          </div>
        )}

        {admin && task.status === "pending_review" && (
          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <ReviewFooter task={task} memberName={memberName} />
          </div>
        )}

        {admin && task.status !== "completed" && task.status !== "pending_review" && (
          <button
            type="button"
            disabled={pending} aria-busy={pending}
            onClick={() =>
              startTransition(async () => report(await sendNudge(task.id)))
            }
            className="mt-5 rounded-full border border-amber-300 bg-amber-50 px-4 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            📣 Nudge {memberName(task.assigned_to, task.assigned_label)}
          </button>
        )}

        {task.description && (
          <div className="mt-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Description
            </p>
            <p className="mt-2 whitespace-pre-wrap rounded-xl bg-warm/50 px-4 py-3 text-sm leading-relaxed text-ink/80">
              {task.description}
            </p>
          </div>
        )}

        <div className="mt-6 border-t border-stone/40 pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            💬 Comments ({task.board_comments?.length ?? 0})
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {(task.board_comments ?? []).map((c) => (
              <div
                key={c.id}
                className="rounded-xl border-l-2 border-stone bg-warm/40 px-4 py-2.5"
              >
                <p className="text-[11px] font-medium text-muted">
                  {memberName(c.author, c.author_label)} ·{" "}
                  {new Date(c.created_at).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
                <p className="mt-0.5 text-sm text-ink/80">{c.text}</p>
              </div>
            ))}
            {(task.board_comments ?? []).length === 0 && (
              <p className="text-xs text-muted">No comments yet.</p>
            )}
          </div>
          <div className="mt-3 flex gap-2">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submitComment();
              }}
              placeholder="Add a comment…"
              rows={2}
              className="flex-1 resize-y rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              disabled={pending} aria-busy={pending}
              onClick={submitComment}
              className="self-end rounded-full bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-accent-dark disabled:opacity-50"
            >
              Send
            </button>
          </div>
          <p className="mt-1 text-[10px] text-muted">⌘/Ctrl+Enter to send</p>
        </div>
      </div>
    </div>
  );
}

// ── Create modal ─────────────────────────────────────────────────────────────

function CreateModal({
  admin,
  meId,
  members,
  onClose,
}: {
  admin: boolean;
  meId: string;
  members: Member[];
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    title: "",
    description: "",
    deadline: "",
    urgent: false,
    recurring: false,
    recurring_day: new Date().getDate(),
    assigned_to: admin ? members.find((m) => !m.isAdmin)?.id ?? meId : meId,
  });
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!form.title.trim()) {
      toast.error("Project title is required.");
      return;
    }
    const fd = new FormData();
    fd.set("title", form.title);
    fd.set("description", form.description);
    fd.set("deadline", form.deadline);
    if (form.urgent) fd.set("urgent", "on");
    if (form.recurring) {
      fd.set("recurring", "on");
      fd.set("recurring_day", String(form.recurring_day));
    }
    fd.set("assigned_to", form.assigned_to);
    startTransition(async () => {
      const r = await createTask(undefined, fd);
      report(r);
      if (!r?.error) onClose();
    });
  }

  const fieldCls =
    "w-full rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-7 shadow-xl">
        <h2 className="text-xl tracking-tight text-ink">
          New <span className="font-display text-accent-text">project</span>
        </h2>

        <div className="mt-5 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Project title *
            </span>
            <input
              autoFocus
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="What needs to be done?"
              className={fieldCls}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Description
            </span>
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
              placeholder="Add details, context, instructions…"
              className={`${fieldCls} resize-y`}
            />
          </label>

          {admin ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Assign to
              </span>
              <select
                value={form.assigned_to}
                onChange={(e) =>
                  setForm((f) => ({ ...f, assigned_to: e.target.value }))
                }
                className={fieldCls}
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.isAdmin ? " (admin)" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="rounded-xl bg-warm/60 px-4 py-2.5 text-sm text-ink/80">
              Assigning to <strong>you</strong>.
            </p>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={form.recurring}
              onChange={(e) =>
                setForm((f) => ({ ...f, recurring: e.target.checked }))
              }
              className="accent-accent"
            />
            Recurring monthly
          </label>

          {form.recurring ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Repeats on day
              </span>
              <select
                value={form.recurring_day}
                onChange={(e) =>
                  setForm((f) => ({ ...f, recurring_day: Number(e.target.value) }))
                }
                className={fieldCls}
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {ordinal(d)}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted">
                If a month is shorter, it falls on that month&apos;s last day.
              </span>
            </label>
          ) : (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Deadline
              </span>
              <input
                type="date"
                value={form.deadline}
                onChange={(e) =>
                  setForm((f) => ({ ...f, deadline: e.target.value }))
                }
                className={fieldCls}
              />
            </label>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={form.urgent}
              onChange={(e) => setForm((f) => ({ ...f, urgent: e.target.checked }))}
              className="accent-accent"
            />
            Mark as urgent
          </label>
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            disabled={pending} aria-busy={pending}
            onClick={submit}
            className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-accent-dark disabled:opacity-50"
          >
            {pending ? "Creating…" : "Create Project"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-xs uppercase tracking-wide text-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
