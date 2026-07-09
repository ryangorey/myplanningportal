// myplanningportal-api -- shared backend Worker
// Equipment + Packages CRUD (staff-only admin screens hit these endpoints
// instead of anyone ever touching SQL directly), plus staff login/session
// auth from auth.js protecting the write routes.

import { login, logout, getSessionStaff, getMyStaffAccount, updateMyStaffAccount, roleAtLeast } from "./auth.js";
import { getAvailability, createBooking, listBookings, getBooking, updateBooking } from "./bookings.js";
import { signup, login as customerLogin, verifyEmail, resendVerification, logoutCustomer, getMe, getMyBookings } from "./customer-auth.js";
import { setupPage, submitSetup } from "./setup.js";
import { createPayment } from "./payments.js";
import { saveSelection } from "./selections.js";
import { listCustomers, getCustomer, createCustomer, updateCustomer } from "./customers.js";
import { listStaff, createStaff, updateStaff, deactivateStaff } from "./staff.js";
import { createBrand, updateBrand, deleteBrand, uploadBrandLogo, serveUpload } from "./branding.js";
import { listMyTasks, createTask, updateTask, deleteTask } from "./tasks.js";

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
// staff_sessions (see auth.js). Optionally require a minimum role in the
// employee < sales < admin < super_admin hierarchy, e.g.
// requireStaffAdmin(request, env, "admin") means admin OR super_admin.
async function requireStaffAdmin(request, env, minRole) {
  const staffRow = await getSessionStaff(request, env);
  if (!staffRow) {
    return { error: json({ error: "Sign in required." }, 401) };
  }
  if (minRole && !roleAtLeast(staffRow.role, minRole)) {
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
// Venues
// ---------------------------------------------------------------------------

async function listVenues(env, url) {
  const includeInactive = url.searchParams.get("include_inactive") === "1";
  let query = "SELECT id, name, address, city, state, zip, contact_name, contact_phone, contact_email, notes, is_active FROM venues";
  if (!includeInactive) query += " WHERE is_active = 1";
  query += " ORDER BY name";
  const { results } = await env.DB.prepare(query).all();
  return json(results);
}

async function createVenue(request, env) {
  const body = await readJson(request);
  if (!body || !body.name) {
    return json({ error: "name is required." }, 400);
  }
  const result = await env.DB.prepare(
    `INSERT INTO venues (name, address, city, state, zip, contact_name, contact_phone, contact_email, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      body.name,
      body.address ?? null,
      body.city ?? null,
      body.state ?? null,
      body.zip ?? null,
      body.contact_name ?? null,
      body.contact_phone ?? null,
      body.contact_email ?? null,
      body.notes ?? null
    )
    .run();
  return json({ id: result.meta.last_row_id, ...body }, 201);
}

async function updateVenue(request, env, id) {
  const body = await readJson(request);
  if (!body) return json({ error: "Invalid request body." }, 400);
  const fields = [];
  const values = [];
  for (const key of [
    "name",
    "address",
    "city",
    "state",
    "zip",
    "contact_name",
    "contact_phone",
    "contact_email",
    "notes",
    "is_active",
  ]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (fields.length === 0) return json({ error: "Nothing to update." }, 400);
  values.push(id);
  await env.DB.prepare(`UPDATE venues SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return json({ id: Number(id), ...body });
}

async function deactivateVenue(env, id) {
  await env.DB.prepare("UPDATE venues SET is_active = 0 WHERE id = ?").bind(id).run();
  return json({ id: Number(id), is_active: 0 });
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

// GET /api/brands -- public read. Includes logo_url/primary_color so both
// the admin topbar and the customer portal can render branding without a
// separate staff-only lookup -- none of this is sensitive data.
async function listBrands(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, slug, display_name, portal_domain, logo_url, primary_color FROM brands ORDER BY id"
  ).all();
  return json(results);
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

async function listPackages(env, url) {
  const brandSlug = url.searchParams.get("brand");
  const includeInactive = url.searchParams.get("include_inactive") === "1";

  let query = `SELECT p.id, p.brand_id, b.slug AS brand_slug, p.name, p.category,
                      p.price, p.duration_hours, p.description, p.is_active,
                      p.booth_type, p.allow_backdrop_selection, p.allow_template_selection
               FROM packages p
               LEFT JOIN brands b ON b.id = p.brand_id`;
  const conditions = [];
  const params = [];
  if (brandSlug) {
    conditions.push("(b.slug = ? OR p.brand_id IS NULL)");
    params.push(brandSlug);
  }
  if (!includeInactive) {
    conditions.push("p.is_active = 1");
  }
  if (conditions.length) {
    query += " WHERE " + conditions.join(" AND ");
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
    `INSERT INTO packages (brand_id, name, category, price, duration_hours, description,
                            booth_type, allow_backdrop_selection, allow_template_selection)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      body.brand_id ?? null,
      body.name,
      body.category ?? null,
      body.price,
      body.duration_hours ?? null,
      body.description ?? null,
      body.booth_type ?? null,
      body.allow_backdrop_selection ?? 1,
      body.allow_template_selection ?? 1
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
    "booth_type",
    "allow_backdrop_selection",
    "allow_template_selection",
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
      if (request.method === "POST" && id === "customer-signup") return addCors(await signup(request, env, json));
      if (request.method === "POST" && id === "customer-login") return addCors(await customerLogin(request, env, json));
      if (request.method === "POST" && id === "customer-verify-email") return addCors(await verifyEmail(request, env, json));
      if (request.method === "POST" && id === "customer-resend-verification") return addCors(await resendVerification(request, env, json));
      if (request.method === "POST" && id === "customer-logout") return addCors(await logoutCustomer(request, env, json));
      return addCors(json({ error: "Not found." }, 404));
    }

    // The logged-in customer's own profile and bookings.
    if (resource === "me") {
      if (request.method === "GET" && !id) return addCors(await getMe(request, env, json));
      if (request.method === "GET" && id === "bookings") return addCors(await getMyBookings(request, env, json));
      return addCors(json({ error: "Not found." }, 404));
    }

    // Brands: public read (used by admin screens for dropdowns, and by the
    // customer portal for branding). Editing name/color and uploading a
    // logo are admin+ only. Adding or deleting a brand outright is
    // super_admin only -- that's a structural change to the whole system,
    // not routine day-to-day branding upkeep.
    if (resource === "brands") {
      if (request.method === "GET" && !id) return addCors(await listBrands(env));
      if (!id && request.method === "POST") {
        const auth = await requireStaffAdmin(request, env, "super_admin");
        if (auth.error) return addCors(auth.error);
        return addCors(await createBrand(request, env, json));
      }
      if (id && subresource === "logo" && request.method === "POST") {
        const auth = await requireStaffAdmin(request, env, "admin");
        if (auth.error) return addCors(auth.error);
        return addCors(await uploadBrandLogo(request, env, id, json));
      }
      if (id && !subresource && request.method === "PATCH") {
        const auth = await requireStaffAdmin(request, env, "admin");
        if (auth.error) return addCors(auth.error);
        return addCors(await updateBrand(request, env, id, json));
      }
      if (id && !subresource && request.method === "DELETE") {
        const auth = await requireStaffAdmin(request, env, "super_admin");
        if (auth.error) return addCors(auth.error);
        return addCors(await deleteBrand(env, id, json));
      }
      return addCors(json({ error: "Not found." }, 404));
    }

    // Uploaded logo images: public read, served straight out of R2.
    if (resource === "uploads" && id) {
      if (request.method === "GET") return addCors(await serveUpload(env, id));
      return addCors(json({ error: "Not found." }, 404));
    }

    // Staff's own account -- name/email/password, distinct from any
    // particular staff_id so a staff member can only ever edit themselves.
    // Available to every role (never accepts a role field, so this can
    // never be used to self-promote).
    if (resource === "staff" && id === "me") {
      if (request.method === "GET") return addCors(await getMyStaffAccount(request, env, json));
      if (request.method === "PATCH") return addCors(await updateMyStaffAccount(request, env, json));
      return addCors(json({ error: "Not found." }, 404));
    }

    // Staff management -- adding/editing/deactivating OTHER staff accounts.
    // admin+ only; staff.js further restricts admin (not super_admin) to
    // only ever touching sales/employee rows, never admin/super_admin ones.
    if (resource === "staff" && id !== "me") {
      const auth = await requireStaffAdmin(request, env, "admin");
      if (auth.error) return addCors(auth.error);
      if (request.method === "GET" && !id) return addCors(await listStaff(env, json));
      if (request.method === "POST" && !id) return addCors(await createStaff(request, env, auth.staff.role, json));
      if (request.method === "PATCH" && id) return addCors(await updateStaff(request, env, id, auth.staff.id, auth.staff.role, json));
      if (request.method === "DELETE" && id) return addCors(await deactivateStaff(env, id, auth.staff.id, auth.staff.role, json));
      return addCors(json({ error: "Not found." }, 404));
    }

    // Tasks: personal to-do list powering the Home dashboard's Tasks
    // widget. Any signed-in staffer can manage their own tasks; assigning
    // one to someone else needs admin+ (see tasks.js for the full rule).
    if (resource === "tasks") {
      const auth = await requireStaffAdmin(request, env);
      if (auth.error) return addCors(auth.error);
      if (request.method === "GET" && !id) return addCors(await listMyTasks(env, auth.staff.id, json));
      if (request.method === "POST" && !id) return addCors(await createTask(request, env, auth.staff.id, auth.staff.role, json));
      if (request.method === "PATCH" && id) return addCors(await updateTask(request, env, id, auth.staff.id, auth.staff.role, json));
      if (request.method === "DELETE" && id) return addCors(await deleteTask(env, id, auth.staff.id, auth.staff.role, json));
      return addCors(json({ error: "Not found." }, 404));
    }

    // Clients: sales+ only (employees don't get customer PII).
    if (resource === "customers") {
      const auth = await requireStaffAdmin(request, env, "sales");
      if (auth.error) return addCors(auth.error);
      if (request.method === "GET" && !id) return addCors(await listCustomers(env, url, json));
      if (request.method === "GET" && id) return addCors(await getCustomer(env, id, json));
      if (request.method === "POST" && !id) return addCors(await createCustomer(request, env, json));
      if (request.method === "PATCH" && id) return addCors(await updateCustomer(request, env, id, json));
      return addCors(json({ error: "Not found." }, 404));
    }

    // Venues: public read (booking forms on the marketing sites may want to
    // show a venue list someday), writes are sales+ only.
    if (resource === "venues") {
      if (request.method === "GET" && !id) return addCors(await listVenues(env, url));
      const auth = await requireStaffAdmin(request, env, "sales");
      if (auth.error) return addCors(auth.error);
      if (request.method === "POST" && !id) return addCors(await createVenue(request, env));
      if (request.method === "PATCH" && id) return addCors(await updateVenue(request, env, id));
      if (request.method === "DELETE" && id) return addCors(await deactivateVenue(env, id));
    }

    // Reads are open (customer-facing screens need to see the catalog, and
    // employees get view-only access this way too). Writes are admin+ only.
    if (resource === "equipment") {
      if (request.method === "GET" && !id) return addCors(await listEquipment(env));
      const auth = await requireStaffAdmin(request, env, "admin");
      if (auth.error) return addCors(auth.error);
      if (request.method === "POST" && !id) return addCors(await createEquipment(request, env));
      if (request.method === "PATCH" && id) return addCors(await updateEquipment(request, env, id));
      if (request.method === "DELETE" && id) return addCors(await deactivateEquipment(env, id));
    }

    // Same story: open reads (sales gets view-only this way), admin+ writes.
    if (resource === "packages") {
      if (request.method === "GET" && !id) return addCors(await listPackages(env, url));
      const auth = await requireStaffAdmin(request, env, "admin");
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

      // Same story for saving a backdrop/template pick -- the customer's
      // own action on their own booking, not a staff one.
      if (request.method === "POST" && id && subresource === "selection") {
        return addCors(await saveSelection(request, env, id, json));
      }

      // Any active staff role, including employee, can view bookings and
      // the calendar. Editing (PATCH) needs sales+ -- employees are
      // view-only here.
      const auth = await requireStaffAdmin(request, env);
      if (auth.error) return addCors(auth.error);
      if (request.method === "GET" && !id) return addCors(await listBookings(env, url, json));
      if (request.method === "GET" && id) return addCors(await getBooking(env, id, json));
      if (request.method === "PATCH" && id) {
        if (!roleAtLeast(auth.staff.role, "sales")) {
          return addCors(json({ error: "You don't have access to do that." }, 403));
        }
        return addCors(await updateBooking(request, env, id, json));
      }
    }

    return addCors(json({ error: "Not found." }, 404));
  },
};
