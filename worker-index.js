// myplanningportal-api -- shared backend Worker
// Equipment + Packages CRUD (staff-only admin screens hit these endpoints
// instead of anyone ever touching SQL directly), plus staff login/session
// auth from auth.js protecting the write routes.

import { login, logout, getSessionStaff } from "./auth.js";
import { getAvailability, createBooking, listBookings, getBooking, updateBooking } from "./bookings.js";
import { requestLink, verifyLink, logoutCustomer, getMe, getMyBookings } from "./customer-auth.js";
import { setupPage, submitSetup } from "./setup.js";
import { createPayment } from "./payments.js";

const JSON_HEADERS = { "content-type": "application/json" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*", // tighten to your real portal domains before going live
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
}

// Real auth check: verifies the bearer token against an active session in
// staff_sessions (see auth.js). Optionally require a specific role, e.g.
// requireStaffAdmin(request, env, "admin") for admin-only routes.
async function requireStaffAdmin(request, env, minRole) {
  const staffRow = await getSessionStaff(request, env);
  if (!staffRow) {
    return { error: json({ error: "Sign in required." }, 401) };
  }
  if (minRole && staffRow.role !== minRole) {
    return { error: json({ error: "You don't have access to do that." }, 403) };
  }
  return { staff: staffRow };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

async function listEquipment(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, category, notes, is_active FROM equipment ORDER BY category, name"
  ).all();
  return json(results);
}

async function createEquipment(request, env) {
  const body = await readJson(request);
  if (!body || !body.name || !body.category) {
    return json({ error: "name and category are required." }, 400);
  }
  const result = await env.DB.prepare(
    "INSERT INTO equipment (name, category, notes) VALUES (?, ?, ?)"
  )
    .bind(body.name, body.category, body.notes ?? null)
    .run();
  return json({ id: result.meta.last_row_id, ...body }, 201);
}

async function updateEquipment(request, env, id) {
  const body = await readJson(request);
  if (!body) return json({ error: "Invalid request body." }, 400);
  const fields = [];
  const values = [];
  for (const key of ["name", "category", "notes", "is_active"]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (fields.length === 0) return json({ error: "Nothing to update." }, 400);
  values.push(id);
  await env.DB.prepare(`UPDATE equipment SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return json({ id: Number(id), ...body });
}

async function deactivateEquipment(env, id) {
  // Soft delete -- keeps history intact for any past bookings that reference it.
  await env.DB.prepare("UPDATE equipment SET is_active = 0 WHERE id = ?").bind(id).run();
  return json({ id: Number(id), is_active: 0 });
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

// GET /api/brands -- public read, just id/slug/display_name. Lets admin
// screens populate a real brand dropdown instead of guessing brand_id numbers.
async function listBrands(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, slug, display_name, portal_domain FROM brands ORDER BY id"
  ).all();
  return json(results);
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

async function listPackages(env, url) {
  const brandSlug = url.searchParams.get("brand");
  let query = `SELECT p.id, p.brand_id, b.slug AS brand_slug, p.name, p.category,
                      p.price, p.duration_hours, p.description, p.is_active
               FROM packages p
               LEFT JOIN brands b ON b.id = p.brand_id`;
  const params = [];
  if (brandSlug) {
    query += " WHERE b.slug = ? OR p.brand_id IS NULL";
    params.push(brandSlug);
  }
  query += " ORDER BY p.category, p.name";
  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json(results);
}

async function createPackage(request, env) {
  const body = await readJson(request);
  if (!body || !body.name || body.price == null) {
    return json({ error: "name and price are required." }, 400);
  }
  const result = await env.DB.prepare(
    `INSERT INTO packages (brand_id, name, category, price, duration_hours, description)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      body.brand_id ?? null,
      body.name,
      body.category ?? null,
      body.price,
      body.duration_hours ?? null,
      body.description ?? null
    )
    .run();
  return json({ id: result.meta.last_row_id, ...body }, 201);
}

async function updatePackage(request, env, id) {
  const body = await readJson(request);
  if (!body) return json({ error: "Invalid request body." }, 400);
  const fields = [];
  const values = [];
  for (const key of [
    "brand_id",
    "name",
    "category",
    "price",
    "duration_hours",
    "description",
    "is_active",
  ]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (fields.length === 0) return json({ error: "Nothing to update." }, 400);
  values.push(id);
  await env.DB.prepare(`UPDATE packages SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return json({ id: Number(id), ...body });
}

async function deactivatePackage(env, id) {
  await env.DB.prepare("UPDATE packages SET is_active = 0 WHERE id = ?").bind(id).run();
  return json({ id: Number(id), is_active: 0 });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // Plain browser page, not a JSON API route -- one-time admin setup.
    if (url.pathname === "/setup") {
      if (request.method === "GET") return await setupPage(env);
      if (request.method === "POST") return await submitSetup(request, env);
    }

    const parts = url.pathname.split("/").filter(Boolean); // ['api','bookings','12','pay']
    const [, resource, id, subresource] = parts;
    const addCors = (resp) => {
      for (const [k, v] of Object.entries(corsHeaders())) resp.headers.set(k, v);
      return resp;
    };

    if (parts[0] !== "api") {
      return addCors(json({ error: "Not found." }, 404));
    }

    // Auth: staff login/logout, customer magic-link request/verify/logout.
    if (resource === "auth") {
      if (request.method === "POST" && id === "login") return addCors(await login(request, env, json));
      if (request.method === "POST" && id === "logout") return addCors(await logout(request, env, json));
      if (request.method === "POST" && id === "customer-login") return addCors(await requestLink(request, env, json));
      if (request.method === "POST" && id === "customer-verify") return addCors(await verifyLink(request, env, json));
      if (request.method === "POST" && id === "customer-logout") return addCors(await logoutCustomer(request, env, json));
      return addCors(json({ error: "Not found." }, 404));
    }

    // The logged-in customer's own profile and bookings.
    if (resource === "me") {
      if (request.method === "GET" && !id) return addCors(await getMe(request, env, json));
      if (request.method === "GET" && id === "bookings") return addCors(await getMyBookings(request, env, json));
      return addCors(json({ error: "Not found." }, 404));
    }

    // Brands: public read-only, used by admin screens for dropdowns.
    if (resource === "brands") {
      if (request.method === "GET" && !id) return addCors(await listBrands(env));
      return addCors(json({ error: "Not found." }, 404));
    }

    // Reads are open (customer-facing screens need to see the catalog).
    // Writes require staff auth (any active role for now; tighten to
    // "admin" specifically if you want attendants/DJs read-only here).
    if (resource === "equipment") {
      if (request.method === "GET" && !id) return addCors(await listEquipment(env));
      const auth = await requireStaffAdmin(request, env);
      if (auth.error) return addCors(auth.error);
      if (request.method === "POST" && !id) return addCors(await createEquipment(request, env));
      if (request.method === "PATCH" && id) return addCors(await updateEquipment(request, env, id));
      if (request.method === "DELETE" && id) return addCors(await deactivateEquipment(env, id));
    }

    if (resource === "packages") {
      if (request.method === "GET" && !id) return addCors(await listPackages(env, url));
      const auth = await requireStaffAdmin(request, env);
      if (auth.error) return addCors(auth.error);
      if (request.method === "POST" && !id) return addCors(await createPackage(request, env));
      if (request.method === "PATCH" && id) return addCors(await updatePackage(request, env, id));
      if (request.method === "DELETE" && id) return addCors(await deactivatePackage(env, id));
    }

    // Availability: public read, used by all three portals before/while booking.
    if (resource === "availability") {
      if (request.method === "GET") return addCors(await getAvailability(env, url, json));
    }

    // Bookings: creation is public (this is what the Contact forms submit
    // to). Everything else -- listing, detail, updates/equipment+staff
    // assignment -- requires staff auth.
    if (resource === "bookings") {
      if (request.method === "POST" && !id) return addCors(await createBooking(request, env, json));

      // Paying a balance is the customer's own action, authenticated as a
      // customer session -- not staff -- so this has to be handled before
      // the staff-auth gate below.
      if (request.method === "POST" && id && subresource === "pay") {
        return addCors(await createPayment(request, env, id, json));
      }

      const auth = await requireStaffAdmin(request, env);
      if (auth.error) return addCors(auth.error);
      if (request.method === "GET" && !id) return addCors(await listBookings(env, url, json));
      if (request.method === "GET" && id) return addCors(await getBooking(env, id, json));
      if (request.method === "PATCH" && id) return addCors(await updateBooking(request, env, id, json));
    }

    return addCors(json({ error: "Not found." }, 404));
  },
};
