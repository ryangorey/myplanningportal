// CRM point-of-contact log: calls, emails, meetings, and general notes
// tracked against a client, so anyone on the sales+ side can see the full
// contact history without having to ask around. Same permission bar as
// clients themselves (sales+) -- no separate role logic needed here.

const VALID_TYPES = ["call", "email", "meeting", "note"];

// GET /api/customers/:id/contacts
async function listContactsForCustomer(env, customerId, json) {
  const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(customerId).first();
  if (!customer) return json({ error: "Client not found." }, 404);

  const { results } = await env.DB.prepare(
    `SELECT cc.id, cc.customer_id, cc.contact_type, cc.notes, cc.contacted_at, cc.created_at,
            s.first_name AS staff_first_name, s.last_name AS staff_last_name
     FROM client_contacts cc
     LEFT JOIN staff s ON s.id = cc.staff_id
     WHERE cc.customer_id = ?
     ORDER BY cc.contacted_at DESC, cc.created_at DESC`
  )
    .bind(customerId)
    .all();
  return json(results);
}

// POST /api/customers/:id/contacts  { contact_type, notes?, contacted_at? }
// contacted_at defaults to now -- lets someone log a call from earlier
// today (or backfill one they forgot) without it being a lie about when
// it happened.
async function createContact(request, env, customerId, staffId, json) {
  const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(customerId).first();
  if (!customer) return json({ error: "Client not found." }, 404);

  const body = await request.json().catch(() => null);
  if (!body || !body.contact_type) {
    return json({ error: "Contact type is required." }, 400);
  }
  if (!VALID_TYPES.includes(body.contact_type)) {
    return json({ error: "That's not a valid contact type." }, 400);
  }

  const result = await env.DB.prepare(
    `INSERT INTO client_contacts (customer_id, staff_id, contact_type, notes, contacted_at)
     VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`
  )
    .bind(customerId, staffId, body.contact_type, body.notes ?? null, body.contacted_at ?? null)
    .run();

  return json({ id: result.meta.last_row_id, customer_id: Number(customerId), contact_type: body.contact_type }, 201);
}

// DELETE /api/client-contacts/:id
async function deleteContact(env, id, json) {
  const contact = await env.DB.prepare("SELECT id FROM client_contacts WHERE id = ?").bind(id).first();
  if (!contact) return json({ error: "Contact entry not found." }, 404);
  await env.DB.prepare("DELETE FROM client_contacts WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

export { listContactsForCustomer, createContact, deleteContact };
