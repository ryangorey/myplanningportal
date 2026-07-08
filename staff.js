// Staff account management -- adding, editing, and deactivating OTHER staff
// members. Distinct from auth.js's getMyStaffAccount/updateMyStaffAccount,
// which only ever touch the logged-in staffer's own row and never accept a
// role change (self-promotion is never possible through that endpoint).
//
// Every function here is called from a route already gated to admin+ by
// requireStaffAdmin(request, env, "admin") in worker-index.js -- but "admin"
// and "super_admin" have different reach within that gate:
//   - super_admin can create/edit/deactivate anyone, including other
//     super_admins and admins.
//   - admin can only create/edit/deactivate "sales" and "employee" accounts.
//     They can never touch an admin or super_admin row, including their own
//     role (role changes to your own account go through /api/staff/me,
//     which never accepts a role field at all).

import { hashPassword } from "./auth.js";

const VALID_ROLES = ["employee", "sales", "admin", "super_admin"];

function canManageRole(actorRole, targetRole) {
  if (actorRole === "super_admin") return true;
  if (actorRole === "admin") return targetRole === "sales" || targetRole === "employee";
  return false;
}

// GET /api/staff -- admin+ only (route-gated). Never returns password_hash.
async function listStaff(env, json) {
  const { results } = await env.DB.prepare(
    `SELECT id, email, first_name, last_name, role, is_active, created_at FROM staff
     ORDER BY is_active DESC, COALESCE(last_name, ''), COALESCE(first_name, ''), email`
  ).all();
  return json(results);
}

// POST /api/staff  { email, password, role, first_name?, last_name? }
async function createStaff(request, env, actorRole, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.email || !body.password || !body.role) {
    return json({ error: "Email, password, and role are required." }, 400);
  }
  if (!VALID_ROLES.includes(body.role)) {
    return json({ error: "That's not a valid role." }, 400);
  }
  if (!canManageRole(actorRole, body.role)) {
    return json({ error: "You don't have permission to create an account with that role." }, 403);
  }
  if (body.password.length < 8) {
    return json({ error: "Password needs to be at least 8 characters." }, 400);
  }

  const email = body.email.toLowerCase().trim();
  const existing = await env.DB.prepare("SELECT id FROM staff WHERE email = ?").bind(email).first();
  if (existing) {
    return json({ error: "A staff account with that email already exists.", id: existing.id }, 409);
  }

  const passwordHash = await hashPassword(body.password);
  const result = await env.DB.prepare(
    "INSERT INTO staff (email, password_hash, first_name, last_name, role) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(email, passwordHash, body.first_name ?? null, body.last_name ?? null, body.role)
    .run();

  return json(
    {
      id: result.meta.last_row_id,
      email,
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      role: body.role,
      is_active: 1,
    },
    201
  );
}

// PATCH /api/staff/:id  { first_name?, last_name?, email?, role?, new_password?, is_active? }
async function updateStaff(request, env, id, actorId, actorRole, json) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid request body." }, 400);

  const target = await env.DB.prepare("SELECT id, role FROM staff WHERE id = ?").bind(id).first();
  if (!target) return json({ error: "Staff account not found." }, 404);
  if (Number(id) === Number(actorId)) {
    return json({ error: "Use Account details to edit your own account." }, 400);
  }

  if (!canManageRole(actorRole, target.role)) {
    return json({ error: "You don't have permission to change that account." }, 403);
  }

  if ("role" in body) {
    if (!VALID_ROLES.includes(body.role)) return json({ error: "That's not a valid role." }, 400);
    if (!canManageRole(actorRole, body.role)) {
      return json({ error: "You don't have permission to assign that role." }, 403);
    }
  }

  const fields = [];
  const values = [];
  for (const key of ["first_name", "last_name", "role", "is_active"]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if ("email" in body && body.email) {
    fields.push("email = ?");
    values.push(body.email.toLowerCase().trim());
  }
  if (body.new_password) {
    if (body.new_password.length < 8) {
      return json({ error: "Password needs to be at least 8 characters." }, 400);
    }
    fields.push("password_hash = ?");
    values.push(await hashPassword(body.new_password));
  }

  if (fields.length === 0) return json({ error: "Nothing to update." }, 400);
  values.push(id);

  await env.DB.prepare(`UPDATE staff SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  return json({ ok: true });
}

// DELETE /api/staff/:id -- soft delete, same pattern as equipment/packages/venues.
async function deactivateStaff(env, id, actorId, actorRole, json) {
  if (Number(id) === Number(actorId)) {
    return json({ error: "You can't deactivate your own account." }, 400);
  }
  const target = await env.DB.prepare("SELECT id, role FROM staff WHERE id = ?").bind(id).first();
  if (!target) return json({ error: "Staff account not found." }, 404);
  if (!canManageRole(actorRole, target.role)) {
    return json({ error: "You don't have permission to deactivate that account." }, 403);
  }
  await env.DB.prepare("UPDATE staff SET is_active = 0 WHERE id = ?").bind(id).run();
  return json({ id: Number(id), is_active: 0 });
}

export { listStaff, createStaff, updateStaff, deactivateStaff, canManageRole, VALID_ROLES };
