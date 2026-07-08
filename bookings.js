// Booking creation, listing, and the cross-brand availability/conflict
// checks -- this is the piece that actually keeps RGML, Grin + Bear Booth,
// and myplanningportal from double-booking the same gear or the same
// staff member on the same date.

async function getOrCreateCustomer(env, customerInfo) {
  const email = customerInfo.email.toLowerCase().trim();
  const existing = await env.DB.prepare("SELECT id FROM customers WHERE email = ?").bind(email).first();
  if (existing) return existing.id;
  const result = await env.DB.prepare(
    "INSERT INTO customers (email, phone, first_name, last_name) VALUES (?, ?, ?, ?)"
  )
    .bind(email, customerInfo.phone ?? null, customerInfo.first_name ?? null, customerInfo.last_name ?? null)
    .run();
  return result.meta.last_row_id;
}

async function getBrandId(env, slug) {
  const row = await env.DB.prepare("SELECT id FROM brands WHERE slug = ?").bind(slug).first();
  return row ? row.id : null;
}

// GET /api/availability?date=YYYY-MM-DD
// Public -- lets any of the three portals show what's free before a
// customer even has an account. Doesn't expose whose booking is holding
// something, just whether it's free.
async function getAvailability(env, url, json) {
  const date = url.searchParams.get("date");
  if (!date) return json({ error: "date query param is required (YYYY-MM-DD)." }, 400);

  const equipment = await env.DB.prepare(
    `SELECT e.id, e.name, e.category,
            EXISTS(
              SELECT 1 FROM booking_equipment be
              JOIN bookings b ON b.id = be.booking_id
              WHERE be.equipment_id = e.id AND b.event_date = ? AND b.status != 'cancelled'
            ) AS is_booked
     FROM equipment e WHERE e.is_active = 1 ORDER BY e.category, e.name`
  )
    .bind(date)
    .all();

  const staff = await env.DB.prepare(
    `SELECT s.id, s.first_name, s.last_name, s.role,
            EXISTS(
              SELECT 1 FROM booking_staff bs
              JOIN bookings b ON b.id = bs.booking_id
              WHERE bs.staff_id = s.id AND b.event_date = ? AND b.status != 'cancelled'
            ) AS is_booked
     FROM staff s WHERE s.is_active = 1 ORDER BY s.first_name`
  )
    .bind(date)
    .all();

  return json({
    date,
    equipment: equipment.results.map((r) => ({ ...r, is_booked: !!r.is_booked, available: !r.is_booked })),
    staff: staff.results.map((r) => ({ ...r, is_booked: !!r.is_booked, available: !r.is_booked })),
  });
}

// POST /api/bookings -- public. This is what the "Contact" forms on both
// sites should submit to instead of mailto/DJ Event Planner. Creates a
// lead as a status='inquiry' booking; staff convert it later.
//
// package_id is optional. If given, the package's price and its
// booth_type/backdrop/template defaults get pulled onto the new booking
// automatically -- unless the caller explicitly passed its own values for
// those fields, in which case the explicit values win.
async function createBooking(request, env, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.brand_slug || !body.event_date || !body.customer || !body.customer.email) {
    return json({ error: "brand_slug, event_date, and customer.email are required." }, 400);
  }

  const brandId = await getBrandId(env, body.brand_slug);
  if (!brandId) return json({ error: "Unknown brand." }, 400);

  const customerId = await getOrCreateCustomer(env, body.customer);

  const packageId = body.package_id ?? null;
  let packageTotal = body.package_total ?? 0;
  let boothType = body.booth_type ?? null;
  let allowBackdrop = body.allow_backdrop_selection ?? 1;
  let allowTemplate = body.allow_template_selection ?? 1;

  if (packageId) {
    const pkg = await env.DB.prepare(
      "SELECT price, booth_type, allow_backdrop_selection, allow_template_selection FROM packages WHERE id = ?"
    )
      .bind(packageId)
      .first();
    if (pkg) {
      if (body.package_total == null) packageTotal = pkg.price;
      if (body.booth_type === undefined) boothType = pkg.booth_type;
      if (body.allow_backdrop_selection === undefined) allowBackdrop = pkg.allow_backdrop_selection;
      if (body.allow_template_selection === undefined) allowTemplate = pkg.allow_template_selection;
    }
  }

  const result = await env.DB.prepare(
    `INSERT INTO bookings (brand_id, customer_id, package_id, venue_id, event_date, event_type, status, notes,
                            package_total, booth_type, allow_backdrop_selection, allow_template_selection)
     VALUES (?, ?, ?, ?, ?, ?, 'inquiry', ?, ?, ?, ?, ?)`
  )
    .bind(
      brandId,
      customerId,
      packageId,
      body.venue_id ?? null,
      body.event_date,
      body.event_type ?? null,
      body.notes ?? null,
      packageTotal,
      boothType,
      allowBackdrop,
      allowTemplate
    )
    .run();

  return json({ id: result.meta.last_row_id, status: "inquiry" }, 201);
}

// GET /api/bookings -- staff only. Filterable list across all brands.
async function listBookings(env, url, json) {
  const date = url.searchParams.get("date");
  const brandSlug = url.searchParams.get("brand");
  const status = url.searchParams.get("status");

  let query = `SELECT b.id, b.event_date, b.event_type, b.status, b.package_total, b.deposit_paid,
                      br.slug AS brand_slug, br.display_name AS brand_name,
                      c.first_name AS customer_first_name, c.last_name AS customer_last_name,
                      c.email AS customer_email, p.name AS package_name
               FROM bookings b
               JOIN brands br ON br.id = b.brand_id
               LEFT JOIN customers c ON c.id = b.customer_id
               LEFT JOIN packages p ON p.id = b.package_id
               WHERE 1=1`;
  const params = [];
  if (date) {
    query += " AND b.event_date = ?";
    params.push(date);
  }
  if (brandSlug) {
    query += " AND br.slug = ?";
    params.push(brandSlug);
  }
  if (status) {
    query += " AND b.status = ?";
    params.push(status);
  }
  query += " ORDER BY b.event_date DESC";

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json(results);
}

// GET /api/bookings/:id -- staff only. Full detail including assigned
// equipment/staff and payment history.
async function getBooking(env, id, json) {
  const booking = await env.DB.prepare(
    `SELECT b.*, br.slug AS brand_slug, br.display_name AS brand_name,
            c.first_name AS customer_first_name, c.last_name AS customer_last_name,
            c.email AS customer_email, c.phone AS customer_phone,
            p.name AS package_name
     FROM bookings b
     JOIN brands br ON br.id = b.brand_id
     LEFT JOIN customers c ON c.id = b.customer_id
     LEFT JOIN packages p ON p.id = b.package_id
     WHERE b.id = ?`
  )
    .bind(id)
    .first();
  if (!booking) return json({ error: "Booking not found." }, 404);

  const equipment = await env.DB.prepare(
    `SELECT e.id, e.name, e.category FROM booking_equipment be
     JOIN equipment e ON e.id = be.equipment_id WHERE be.booking_id = ?`
  )
    .bind(id)
    .all();

  const staff = await env.DB.prepare(
    `SELECT s.id, s.first_name, s.last_name, s.role FROM booking_staff bs
     JOIN staff s ON s.id = bs.staff_id WHERE bs.booking_id = ?`
  )
    .bind(id)
    .all();

  const payments = await env.DB.prepare(
    `SELECT id, amount, status, created_at FROM payments WHERE booking_id = ? ORDER BY created_at`
  )
    .bind(id)
    .all();

  return json({ ...booking, equipment: equipment.results, staff: staff.results, payments: payments.results });
}

// The actual cross-brand check: do any of these equipment/staff ids
// already belong to a DIFFERENT, non-cancelled booking on this date --
// regardless of which brand that other booking came through. Returns a
// list of conflicts; empty means it's safe to assign.
async function findConflicts(env, date, equipmentIds, staffIds, excludeBookingId) {
  const conflicts = [];

  if (equipmentIds && equipmentIds.length) {
    const placeholders = equipmentIds.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT e.id, e.name, b.id AS booking_id, br.display_name AS brand_name
       FROM booking_equipment be
       JOIN bookings b ON b.id = be.booking_id
       JOIN equipment e ON e.id = be.equipment_id
       JOIN brands br ON br.id = b.brand_id
       WHERE be.equipment_id IN (${placeholders}) AND b.event_date = ? AND b.status != 'cancelled'
         AND b.id != ?`
    )
      .bind(...equipmentIds, date, excludeBookingId ?? -1)
      .all();
    for (const r of results) {
      conflicts.push({
        type: "equipment",
        id: r.id,
        name: r.name,
        conflicting_booking_id: r.booking_id,
        conflicting_brand: r.brand_name,
      });
    }
  }

  if (staffIds && staffIds.length) {
    const placeholders = staffIds.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.first_name, s.last_name, b.id AS booking_id, br.display_name AS brand_name
       FROM booking_staff bs
       JOIN bookings b ON b.id = bs.booking_id
       JOIN staff s ON s.id = bs.staff_id
       JOIN brands br ON br.id = b.brand_id
       WHERE bs.staff_id IN (${placeholders}) AND b.event_date = ? AND b.status != 'cancelled'
         AND b.id != ?`
    )
      .bind(...staffIds, date, excludeBookingId ?? -1)
      .all();
    for (const r of results) {
      conflicts.push({
        type: "staff",
        id: r.id,
        name: `${r.first_name} ${r.last_name}`,
        conflicting_booking_id: r.booking_id,
        conflicting_brand: r.brand_name,
      });
    }
  }

  return conflicts;
}

// PATCH /api/bookings/:id -- staff only. Updates status/pricing/notes and,
// if equipment_ids or staff_ids are included, re-checks for conflicts
// BEFORE writing the new assignment -- this is what actually blocks a
// double-booking rather than just catching it after the fact.
async function updateBooking(request, env, id, json) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid request body." }, 400);

  const existing = await env.DB.prepare("SELECT event_date FROM bookings WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "Booking not found." }, 404);

  const eventDate = body.event_date ?? existing.event_date;

  // Assigning a package pulls its price and booth_type/backdrop/template
  // defaults onto the booking too -- unless the caller already sent its own
  // values for those fields, which win over the package's.
  if ("package_id" in body && body.package_id) {
    const pkg = await env.DB.prepare(
      "SELECT price, booth_type, allow_backdrop_selection, allow_template_selection FROM packages WHERE id = ?"
    )
      .bind(body.package_id)
      .first();
    if (pkg) {
      if (!("package_total" in body)) body.package_total = pkg.price;
      if (!("booth_type" in body)) body.booth_type = pkg.booth_type;
      if (!("allow_backdrop_selection" in body)) body.allow_backdrop_selection = pkg.allow_backdrop_selection;
      if (!("allow_template_selection" in body)) body.allow_template_selection = pkg.allow_template_selection;
    }
  }

  if (body.equipment_ids || body.staff_ids) {
    const conflicts = await findConflicts(env, eventDate, body.equipment_ids, body.staff_ids, id);
    if (conflicts.length > 0) {
      return json({ error: "That would double-book something already reserved.", conflicts }, 409);
    }
  }

  const fields = [];
  const values = [];
  for (const key of [
    "event_date",
    "event_type",
    "status",
    "package_id",
    "venue_id",
    "package_total",
    "deposit_paid",
    "notes",
    "allow_full_payment",
    "allow_retainer_payment",
    "allow_custom_payment",
    "allow_backdrop_selection",
    "allow_template_selection",
    "booth_type",
  ]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (fields.length) {
    values.push(id);
    await env.DB.prepare(`UPDATE bookings SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  }

  if (body.equipment_ids) {
    await env.DB.prepare("DELETE FROM booking_equipment WHERE booking_id = ?").bind(id).run();
    for (const eqId of body.equipment_ids) {
      await env.DB.prepare("INSERT INTO booking_equipment (booking_id, equipment_id) VALUES (?, ?)")
        .bind(id, eqId)
        .run();
    }
  }

  if (body.staff_ids) {
    await env.DB.prepare("DELETE FROM booking_staff WHERE booking_id = ?").bind(id).run();
    for (const stId of body.staff_ids) {
      await env.DB.prepare("INSERT INTO booking_staff (booking_id, staff_id) VALUES (?, ?)").bind(id, stId).run();
    }
  }

  return json({ id: Number(id), updated: true });
}

export { getAvailability, createBooking, listBookings, getBooking, updateBooking, findConflicts };
