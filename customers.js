// Clients (customers) management for staff -- lets staff save contact info
// once and reuse it across future bookings instead of retyping it every
// time. All routes here are staff-only; the customer-facing side of the
// customers table (their own login/profile) lives in customer-auth.js.

// GET /api/customers?search=<text> -- staff only. Simple substring search
// across name/email/phone/organization so staff can find someone fast when
// starting a new booking.
async function listCustomers(env, url, json) {
  const search = (url.searchParams.get("search") || "").trim();

  let query = "SELECT id, email, phone, first_name, last_name, organization, created_at FROM customers";
  const params = [];
  if (search) {
    query += " WHERE email LIKE ? OR phone LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR organization LIKE ?";
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }
  query += " ORDER BY COALESCE(last_name, ''), COALESCE(first_name, ''), email";

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json(results);
}

// GET /api/customers/:id -- staff only. Includes their booking history so
// staff can see past AND upcoming events for this client right alongside
// their contact info -- the frontend splits this list by event_date.
async function getCustomer(env, id, json) {
  const customer = await env.DB.prepare(
    "SELECT id, email, phone, first_name, last_name, organization, created_at FROM customers WHERE id = ?"
  )
    .bind(id)
    .first();
  if (!customer) return json({ error: "Client not found." }, 404);

  const { results: bookings } = await env.DB.prepare(
    `SELECT b.id, b.event_date, b.status, b.package_total, br.display_name AS brand_name, p.name AS package_name
     FROM bookings b
     JOIN brands br ON br.id = b.brand_id
     LEFT JOIN packages p ON p.id = b.package_id
     WHERE b.customer_id = ?
     ORDER BY b.event_date DESC`
  )
    .bind(id)
    .all();

  return json({ ...customer, bookings });
}

// POST /api/customers -- staff only. Lets staff pre-save a client's info
// before any booking exists yet.
async function createCustomer(request, env, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.email) {
    return json({ error: "Email is required." }, 400);
  }
  const email = body.email.toLowerCase().trim();

  const existing = await env.DB.prepare("SELECT id FROM customers WHERE email = ?").bind(email).first();
  if (existing) {
    return json({ error: "A client with that email already exists.", id: existing.id }, 409);
  }

  const result = await env.DB.prepare(
    "INSERT INTO customers (email, phone, first_name, last_name, organization) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(email, body.phone ?? null, body.first_name ?? null, body.last_name ?? null, body.organization ?? null)
    .run();

  return json(
    {
      id: result.meta.last_row_id,
      email,
      phone: body.phone ?? null,
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      organization: body.organization ?? null,
    },
    201
  );
}

// PATCH /api/customers/:id -- staff only. Edits saved contact info.
async function updateCustomer(request, env, id, json) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid request body." }, 400);

  const fields = [];
  const values = [];
  for (const key of ["email", "phone", "first_name", "last_name", "organization"]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(key === "email" && body.email ? body.email.toLowerCase().trim() : body[key]);
    }
  }
  if (fields.length === 0) return json({ error: "Nothing to update." }, 400);
  values.push(id);

  await env.DB.prepare(`UPDATE customers SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  return json({ id: Number(id), ...body });
}

export { listCustomers, getCustomer, createCustomer, updateCustomer };
