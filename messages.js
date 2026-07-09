// Per-booking message thread -- the "Message us" feature on the customer
// portal. Either side can post: the customer (about their own booking
// only) or any signed-in staffer (viewing/replying isn't gated by role,
// same bar as viewing the booking itself -- whoever picks up the message
// replies, no need to be sales+ just to say something back).

import { getSessionCustomer } from "./customer-auth.js";
import { getSessionStaff } from "./auth.js";

// Figures out who's calling and whether they're allowed to touch this
// booking's messages at all. Tries a customer session first, then falls
// back to a staff session -- there's no other way to tell them apart from
// a bearer token alone.
async function resolveSender(request, env, bookingId) {
  const customer = await getSessionCustomer(request, env);
  if (customer) {
    const booking = await env.DB.prepare("SELECT id, customer_id FROM bookings WHERE id = ?").bind(bookingId).first();
    if (!booking) return { error: "not_found" };
    if (booking.customer_id !== customer.id) return { error: "forbidden" };
    return {
      type: "customer",
      customerId: customer.id,
      name: ((customer.first_name || "") + " " + (customer.last_name || "")).trim() || customer.email,
    };
  }

  const staff = await getSessionStaff(request, env);
  if (staff) {
    const booking = await env.DB.prepare("SELECT id FROM bookings WHERE id = ?").bind(bookingId).first();
    if (!booking) return { error: "not_found" };
    return {
      type: "staff",
      staffId: staff.id,
      name: ((staff.first_name || "") + " " + (staff.last_name || "")).trim() || staff.email,
    };
  }

  return { error: "unauthorized" };
}

function errorResponse(json, err) {
  if (err === "unauthorized") return json({ error: "Sign in required." }, 401);
  if (err === "forbidden") return json({ error: "That's not your booking." }, 403);
  if (err === "not_found") return json({ error: "Booking not found." }, 404);
  return json({ error: "Something went wrong." }, 500);
}

// GET /api/bookings/:id/messages -- customer (own booking) or any staff.
async function listMessagesForBooking(request, env, bookingId, json) {
  const sender = await resolveSender(request, env, bookingId);
  if (sender.error) return errorResponse(json, sender.error);

  const { results } = await env.DB.prepare(
    `SELECT m.id, m.sender_type, m.body, m.created_at,
            c.first_name AS customer_first_name, c.last_name AS customer_last_name,
            s.first_name AS staff_first_name, s.last_name AS staff_last_name
     FROM booking_messages m
     LEFT JOIN customers c ON c.id = m.sender_customer_id
     LEFT JOIN staff s ON s.id = m.sender_staff_id
     WHERE m.booking_id = ?
     ORDER BY m.created_at ASC`
  )
    .bind(bookingId)
    .all();

  return json(results);
}

// POST /api/bookings/:id/messages  { body } -- customer (own booking) or any staff.
async function createMessage(request, env, bookingId, json) {
  const sender = await resolveSender(request, env, bookingId);
  if (sender.error) return errorResponse(json, sender.error);

  const body = await request.json().catch(() => null);
  if (!body || !body.body || !body.body.trim()) {
    return json({ error: "Message can't be empty." }, 400);
  }
  const text = body.body.trim();

  const result = await env.DB.prepare(
    `INSERT INTO booking_messages (booking_id, sender_type, sender_customer_id, sender_staff_id, body)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      bookingId,
      sender.type,
      sender.type === "customer" ? sender.customerId : null,
      sender.type === "staff" ? sender.staffId : null,
      text
    )
    .run();

  return json(
    {
      id: result.meta.last_row_id,
      booking_id: Number(bookingId),
      sender_type: sender.type,
      sender_name: sender.name,
      body: text,
    },
    201
  );
}

export { listMessagesForBooking, createMessage };
