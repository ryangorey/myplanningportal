// Lightweight personal task list for staff -- powers the Tasks widget on
// the Home dashboard. Everyone can create/complete/edit/delete tasks
// assigned to themselves. Assigning a task to someone ELSE requires
// admin+ (the same bar as being able to see the staff roster at all, since
// you need that roster to pick who to assign it to). A task's creator and
// any admin+ can also manage it even if it's assigned to someone else, so
// an admin who hands off work can still fix or cancel it later.

import { roleAtLeast } from "./auth.js";

const VALID_STATUSES = ["pending", "completed"];

function canManageTask(actorId, actorRole, task) {
  if (Number(task.assigned_to) === Number(actorId)) return true;
  if (Number(task.created_by) === Number(actorId)) return true;
  if (roleAtLeast(actorRole, "admin")) return true;
  return false;
}

// GET /api/tasks -- every task assigned to the logged-in staffer. The
// frontend splits this into "Upcoming" (pending) and "Completed" sections
// and sorts each side client-side, so this just returns everything.
async function listMyTasks(env, staffId, json) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, notes, due_date, status, assigned_to, created_by, booking_id, completed_at, created_at
     FROM tasks WHERE assigned_to = ?
     ORDER BY due_date IS NULL, due_date ASC, created_at DESC`
  )
    .bind(staffId)
    .all();
  return json(results);
}

// POST /api/tasks  { title, notes?, due_date?, assigned_to?, booking_id? }
// assigned_to defaults to yourself; passing someone else's id needs admin+.
async function createTask(request, env, actorId, actorRole, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.title || !body.title.trim()) {
    return json({ error: "Title is required." }, 400);
  }

  const assignedTo = body.assigned_to ? Number(body.assigned_to) : Number(actorId);
  if (assignedTo !== Number(actorId)) {
    if (!roleAtLeast(actorRole, "admin")) {
      return json({ error: "You can only create tasks for yourself." }, 403);
    }
    const target = await env.DB.prepare("SELECT id FROM staff WHERE id = ? AND is_active = 1")
      .bind(assignedTo)
      .first();
    if (!target) return json({ error: "That staff member doesn't exist." }, 400);
  }

  const result = await env.DB.prepare(
    `INSERT INTO tasks (title, notes, due_date, assigned_to, created_by, booking_id, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  )
    .bind(body.title.trim(), body.notes ?? null, body.due_date ?? null, assignedTo, actorId, body.booking_id ?? null)
    .run();

  return json(
    { id: result.meta.last_row_id, title: body.title.trim(), status: "pending", assigned_to: assignedTo },
    201
  );
}

// PATCH /api/tasks/:id  { title?, notes?, due_date?, status? }
// Setting status to "completed" stamps completed_at; setting it back to
// "pending" clears it.
async function updateTask(request, env, id, actorId, actorRole, json) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid request body." }, 400);

  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
  if (!task) return json({ error: "Task not found." }, 404);
  if (!canManageTask(actorId, actorRole, task)) {
    return json({ error: "You don't have permission to change that task." }, 403);
  }

  const fields = [];
  const values = [];
  if ("title" in body) {
    if (!body.title || !body.title.trim()) return json({ error: "Title can't be empty." }, 400);
    fields.push("title = ?");
    values.push(body.title.trim());
  }
  if ("notes" in body) { fields.push("notes = ?"); values.push(body.notes); }
  if ("due_date" in body) { fields.push("due_date = ?"); values.push(body.due_date); }
  if ("status" in body) {
    if (!VALID_STATUSES.includes(body.status)) return json({ error: "That's not a valid status." }, 400);
    fields.push("status = ?");
    values.push(body.status);
    fields.push("completed_at = ?");
    values.push(body.status === "completed" ? new Date().toISOString() : null);
  }
  if (fields.length === 0) return json({ error: "Nothing to update." }, 400);

  values.push(id);
  await env.DB.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  return json({ ok: true });
}

// DELETE /api/tasks/:id
async function deleteTask(env, id, actorId, actorRole, json) {
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
  if (!task) return json({ error: "Task not found." }, 404);
  if (!canManageTask(actorId, actorRole, task)) {
    return json({ error: "You don't have permission to delete that task." }, 403);
  }
  await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

export { listMyTasks, createTask, updateTask, deleteTask };
