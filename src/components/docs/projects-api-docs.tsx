import { Section, Code, CodeBlock, ParamTable } from "@/components/api-docs";

/**
 * Projects API reference content — served on the PUBLIC /developers page,
 * so example payloads must stay fictional (never paste real task data or
 * user ids here). The API lives in src/app/api/projects/ — keep this in
 * sync when it changes.
 */
export function ProjectsApiDocs() {
  return (
    <>
      <Section title="Authentication & model">
        <p>
          Every request needs <Code>Authorization: Bearer $PROJECTS_API_KEY</Code>.
          Missing or wrong token → <Code>401</Code>; key not configured on
          the server → <Code>503</Code>.
        </p>
        <CodeBlock>{`curl -H "Authorization: Bearer $PROJECTS_API_KEY" \\
  https://your-portal-domain/api/projects?status=pending_review`}</CodeBlock>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            The API acts as the <strong>board admin</strong>. It follows the
            same rules and sends the same notification emails as an admin
            using the Projects board by hand (new project, approved, revision
            needed, comment, deadline change, nudge).
          </li>
          <li>
            <Code>:id</Code> in any path is the task&apos;s uuid <em>or</em>{" "}
            its board number (<Code>seq</Code>, e.g. <Code>12</Code> for
            &quot;#12&quot;).
          </li>
          <li>
            Statuses: <Code>not started</Code>, <Code>in progress</Code>,{" "}
            <Code>pending_review</Code>, <Code>completed</Code>. Recurring
            tasks never sit in <Code>completed</Code>: completing or
            approving one rolls its deadline to next month and resets it to{" "}
            <Code>not started</Code>.
          </li>
          <li>Dates are <Code>YYYY-MM-DD</Code> (Eastern time).</li>
        </ul>
      </Section>

      <Section title="GET /api/projects">
        <p>All tasks, newest first. Filters combine freely:</p>
        <ParamTable
          rows={[
            ["status", "one status, or several comma-separated", "—"],
            ["assigned_to", "a member id (see /members)", "—"],
            ["urgent", "true → urgent only", "—"],
            ["needs_attention", "true → flagged only", "—"],
            ["overdue", "true → deadline passed, not completed", "—"],
            ["q", "case-insensitive substring over title and description", "—"],
            ["include", "comments → embed each task's comments", "—"],
          ]}
        />
        <CodeBlock>{`GET /api/projects?status=in%20progress&include=comments

{
  "as_of": "2026-08-08",
  "count": 1,
  "tasks": [
    {
      "id": "5f0c2a7e-1b3d-4e8a-9c21-7d4e6f8a0b12",
      "seq": 42,
      "title": "Replace hallway light fixtures",
      "description": "Two fixtures on the 3rd floor.",
      "status": "in progress",
      "urgent": false,
      "needs_attention": false,
      "recurring": false,
      "recurring_day": null,
      "deadline": "2026-08-15",
      "overdue": false,
      "assignee": { "id": "0a1b2c3d-0000-4000-8000-000000000001", "name": "Alex Member" },
      "last_completed_month": null,
      "missed_months": [],
      "created_at": "2026-08-01T14:02:11.000Z",
      "updated_at": "2026-08-05T09:30:00.000Z",
      "comments": [
        { "id": "…", "author": "Alex Member", "text": "Parts ordered.", "created_at": "…" }
      ]
    }
  ]
}`}</CodeBlock>
      </Section>

      <Section title="GET /api/projects/members">
        <p>
          Portal users that can be assigned projects:{" "}
          <Code>{`{ "count", "members": [{ "id", "name", "is_admin" }] }`}</Code>.
          Emails are not returned.
        </p>
      </Section>

      <Section title="POST /api/projects">
        <p>Create a task. JSON body:</p>
        <ParamTable
          header={["Field", "Meaning", "Default"]}
          rows={[
            ["title", "required, up to 300 chars", "—"],
            ["description", "free text", "null"],
            ["assigned_to", "member id; the assignee is emailed", "unassigned"],
            ["deadline", "YYYY-MM-DD (ignored when recurring)", "null"],
            ["urgent", "boolean", "false"],
            ["recurring", "boolean — monthly task", "false"],
            ["recurring_day", "1–31, required when recurring (clamps to short months)", "—"],
          ]}
        />
        <CodeBlock>{`POST /api/projects
{ "title": "Renew boiler inspection", "assigned_to": "0a1b2c3d-…", "deadline": "2026-09-01", "urgent": true }

201 { "ok": true, "message": "Project created.", "task": { … } }`}</CodeBlock>
      </Section>

      <Section title="GET · PATCH · DELETE /api/projects/:id">
        <p>
          <Code>GET</Code> returns <Code>{`{ "task" }`}</Code> with comments.{" "}
          <Code>DELETE</Code> removes the task and its comments.
        </p>
        <p>
          <Code>PATCH</Code> takes any of <Code>status</Code>,{" "}
          <Code>needs_attention</Code> (boolean) and <Code>deadline</Code>{" "}
          (date or <Code>null</Code> to clear) and returns the updated task.
          Setting a deadline on a recurring task is a <Code>409</Code>.
        </p>
        <CodeBlock>{`PATCH /api/projects/42
{ "status": "completed" }

200 { "ok": true, "task": { … "status": "completed" … } }`}</CodeBlock>
      </Section>

      <Section title="Review, comments, nudges">
        <ParamTable
          header={["Endpoint", "Body", "Effect"]}
          rows={[
            ["POST /api/projects/:id/approve", "—", "completed (recurring: rolls to next month); emails assignee"],
            ["POST /api/projects/:id/reject", "{ reason? }", "back to in progress; reason saved as a comment; emails assignee"],
            ["POST /api/projects/:id/comments", "{ text, author? }", "adds a comment (author label defaults to \"API\"); emails assignee"],
            ["POST /api/projects/:id/nudge", "—", "reminder email to the assignee; max 2 per task per day"],
          ]}
        />
      </Section>

      <Section title="Errors">
        <p>
          Errors are always JSON: <Code>{`{ "error": "<message>" }`}</Code>.
        </p>
        <ParamTable
          header={["Status", "Meaning", ""]}
          rows={[
            ["400", "Invalid body or query param (message says which)", ""],
            ["401", "Missing or wrong bearer token", ""],
            ["404", "No task with that id / number", ""],
            ["409", "Not allowed in the task's current state (e.g. nudging a completed task)", ""],
            ["429", "Task already nudged twice today", ""],
            ["500", "Database error (message included)", ""],
            ["503", "The API is not configured on the server", ""],
          ]}
        />
      </Section>
    </>
  );
}
