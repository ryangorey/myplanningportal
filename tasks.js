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

// GET /api/tasks -- every task assigned to the logged-in staffer, plus the
// client it's for (if any). The frontend splits this into "Upcoming"
// (pending) and "Completed" sections and sorts each side client-side, so
// this just returns everything.
async function listMyTasks(env, staffId, json) {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.notes, t.due_date, t.status, t.assigned_to, t.created_by,
            t.booking_id, t.customer_id, t.completed_at, t.created_at,
            c.first_name AS customer_first_name, c.last_name AS customer_last_name, c.email AS customer_email
     FROM tasks t
     LEFT JOIN customers c ON c.id = t.customer_id
     WHERE t.assigned_to = ?
     ORDER BY t.due_date IS NULL, t.due_date ASC, t.created_at DESC`
  )
    .bind(staffId)
    .all();
  return json(results);
}

// GET /api/customers/:id/tasks -- every task tied to a client, regardless
// of who it's assigned to. Powers the "Assigned tasks" section on that
// client's detail panel. Sales+ only, same bar as seeing the client at all.
async function listTasksForCustomer(env, customerId, json) {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.notes, t.due_date, t.status, t.assigned_to, t.created_by, t.completed_at, t.created_at,
            s.first_name AS assignee_first_name, s.last_name AS assignee_last_name, s.email AS assignee_email
     FROM tasks t
     LEFT JOIN staff s ON s.id = t.assigned_to
     WHERE t.customer_id = ?
     ORDER BY t.due_date IS NULL, t.due_date ASC, t.created_at DESC`
  )
    .bind(customerId)
    .all();
  return json(results);
}

// POST /api/tasks  { title, notes?, due_date?, assigned_to?, booking_id?, customer_id? }
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

  let customerId = null;
  if (body.customer_id) {
    const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(body.customer_id).first();
    if (!customer) return json({ error: "That client doesn't exist." }, 400);
    customerId = Number(body.customer_id);
  }

  const result = await env.DB.prepare(
    `INSERT INTO tasks (title, notes, due_date, assigned_to, created_by, booking_id, customer_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  )
    .bind(body.title.trim(), body.notes ?? null, body.due_date ?? null, assignedTo, actorId, body.booking_id ?? null, customerId)
    .run();

  return json(
    { id: result.meta.last_row_id, title: body.title.trim(), status: "pending", assigned_to: assignedTo, customer_id: customerId },
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
  if ("customer_id" in body) {
    if (body.customer_id) {
      const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(body.customer_id).first();
      if (!customer) return json({ error: "That client doesn't exist." }, 400);
      fields.push("customer_id = ?");
      values.push(Number(body.customer_id));
    } else {
      fields.push("customer_id = ?");
      values.push(null);
    }
  }
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

export { listMyTasks, listTasksForCustomer, createTask, updateTask, deleteTask };
