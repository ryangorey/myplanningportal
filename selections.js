// Backdrop and template picks. PB Backdrops and the PBT Gallery widgets are
// browse-only -- per PB Backdrops' own site, "They then tell you their
// choice" -- there's no callback or API that reports a selection back to
// us. So the customer picks visually in the embedded widget, then types
// what they picked into a field on the same page, and that's what this
// endpoint saves.

import { getSessionCustomer } from "./customer-auth.js";

const SELECTION_FIELDS = {
  backdrop: { flag: "allow_backdrop_selection", column: "backdrop_choice" },
  template: { flag: "allow_template_selection", column: "template_choice" },
};

// POST /api/bookings/:id/selection  (customer auth required)
// Body: { type: "backdrop" | "template", choice: "<free text>" }
async function saveSelection(request, env, id, json) {
  const customer = await getSessionCustomer(request, env);
  if (!customer) return json({ error: "Sign in required." }, 401);

  const body = await request.json().catch(() => null);
  if (!body || !body.type || !SELECTION_FIELDS[body.type]) {
    return json({ error: 'type must be "backdrop" or "template".' }, 400);
  }
  const choice = (body.choice || "").toString().trim();
  if (!choice) return json({ error: "Enter what you picked." }, 400);

  const booking = await env.DB.prepare(
    `SELECT id, customer_id, allow_backdrop_selection, allow_template_selection, booth_type
     FROM bookings WHERE id = ?`
  )
    .bind(id)
    .first();

  if (!booking) return json({ error: "Booking not found." }, 404);
  if (booking.customer_id !== customer.id) return json({ error: "That's not your booking." }, 403);

  const field = SELECTION_FIELDS[body.type];
  if (!booking[field.flag]) {
    return json({ error: "That option isn't available for this booking." }, 403);
  }
  if (body.type === "template" && !booking.booth_type) {
    return json({ error: "Ask us to set your booth type before picking a template." }, 400);
  }

  await env.DB.prepare(`UPDATE bookings SET ${field.column} = ? WHERE id = ?`)
    .bind(choice, id)
    .run();

  return json({ ok: true, type: body.type, choice });
}

export { saveSelection };
