// Square payment processing. The card itself is tokenized entirely in the
// browser by Square's Web Payments SDK -- this file only ever sees a
// one-time, single-use token (source_id), never a raw card number. That
// token gets exchanged for a real charge here, server-side, using the
// SQUARE_ACCESS_TOKEN secret (never exposed to the browser).
//
// Env vars this needs (set on the myplanningportal-api Worker):
//   SQUARE_ACCESS_TOKEN   -- secret, from Square Developer Dashboard
//   SQUARE_LOCATION_ID    -- plain var, your Square location id
//   SQUARE_ENVIRONMENT    -- plain var, "sandbox" or "production"
//                            (defaults to sandbox if unset -- safer default)

import { getSessionCustomer } from "./customer-auth.js";

const SQUARE_VERSION = "2025-01-23"; // bump per Square's changelog if needed

function squareBaseUrl(env) {
  return env.SQUARE_ENVIRONMENT === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

// POST /api/bookings/:id/pay  (customer auth required)
// Body: { source_id, amount_type: "full" | "retainer" | "custom", amount? }
// amount is only read for amount_type "custom" -- full/retainer are always
// computed server-side from the booking's real balance, never trusted from
// the client.
async function createPayment(request, env, id, json) {
  const customer = await getSessionCustomer(request, env);
  if (!customer) return json({ error: "Sign in required." }, 401);

  const booking = await env.DB.prepare(
    `SELECT id, customer_id, package_total, deposit_paid, status,
            allow_full_payment, allow_retainer_payment, allow_custom_payment
     FROM bookings WHERE id = ?`
  )
    .bind(id)
    .first();

  if (!booking) return json({ error: "Booking not found." }, 404);
  if (booking.customer_id !== customer.id) return json({ error: "That's not your booking." }, 403);
  if (booking.status !== "booked") {
    return json({ error: "Payment isn't open for this booking yet." }, 400);
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.source_id || !body.amount_type) {
    return json({ error: "source_id and amount_type are required." }, 400);
  }

  const balance = Math.round(Math.max(0, (booking.package_total || 0) - (booking.deposit_paid || 0)) * 100) / 100;
  if (balance <= 0) return json({ error: "This booking is already paid in full." }, 400);

  let amount;
  if (body.amount_type === "full") {
    if (!booking.allow_full_payment) return json({ error: "Full payment isn't available for this booking." }, 403);
    amount = balance;
  } else if (body.amount_type === "retainer") {
    if (!booking.allow_retainer_payment) return json({ error: "Retainer payment isn't available for this booking." }, 403);
    amount = Math.min(balance, Math.round((booking.package_total || 0) * 0.5 * 100) / 100);
  } else if (body.amount_type === "custom") {
    if (!booking.allow_custom_payment) return json({ error: "Custom payment isn't available for this booking." }, 403);
    const requested = Number(body.amount);
    if (!requested || requested <= 0) return json({ error: "Enter a valid amount." }, 400);
    if (requested > balance) return json({ error: "That's more than the remaining balance." }, 400);
    amount = Math.round(requested * 100) / 100;
  } else {
    return json({ error: "amount_type must be full, retainer, or custom." }, 400);
  }

  if (amount <= 0) return json({ error: "Nothing to charge." }, 400);

  let squareResp;
  try {
    squareResp = await fetch(`${squareBaseUrl(env)}/v2/payments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        "square-version": SQUARE_VERSION,
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        source_id: body.source_id,
        amount_money: { amount: Math.round(amount * 100), currency: "USD" },
        location_id: env.SQUARE_LOCATION_ID,
      }),
    });
  } catch (err) {
    return json({ error: "Couldn't reach Square. Try again." }, 502);
  }

  const squareData = await squareResp.json().catch(() => null);

  if (!squareResp.ok) {
    const message =
      (squareData && squareData.errors && squareData.errors[0] && squareData.errors[0].detail) ||
      "The payment didn't go through.";
    await env.DB.prepare(
      "INSERT INTO payments (booking_id, amount, square_payment_id, status) VALUES (?, ?, ?, 'failed')"
    )
      .bind(id, amount, null)
      .run();
    return json({ error: message }, 402);
  }

  const squarePayment = squareData.payment;

  await env.DB.prepare(
    "INSERT INTO payments (booking_id, amount, square_payment_id, status) VALUES (?, ?, ?, 'completed')"
  )
    .bind(id, amount, squarePayment.id)
    .run();

  await env.DB.prepare("UPDATE bookings SET deposit_paid = deposit_paid + ? WHERE id = ?")
    .bind(amount, id)
    .run();

  const updated = await env.DB.prepare(
    "SELECT id, package_total, deposit_paid FROM bookings WHERE id = ?"
  )
    .bind(id)
    .first();

  return json({
    ok: true,
    payment_id: squarePayment.id,
    amount_charged: amount,
    booking: {
      id: updated.id,
      package_total: updated.package_total,
      deposit_paid: updated.deposit_paid,
      balance_due: Math.max(0, Math.round((updated.package_total - updated.deposit_paid) * 100) / 100),
    },
  });
}

export { createPayment };
