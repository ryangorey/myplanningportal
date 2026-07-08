-- Shared backend schema for RGML Entertainment / Grin + Bear Booth / myplanningportal
-- Cloudflare D1 (SQLite). One source of truth for bookings, equipment, and staff
-- availability across all three brands.

-- ---------------------------------------------------------------------------
-- Brands: the three client-facing skins. Every booking is tagged with one,
-- but equipment/staff availability checks always look ACROSS all brands.
-- ---------------------------------------------------------------------------
CREATE TABLE brands (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,     -- 'rgml' | 'grinbear' | 'myplanningportal'
  display_name  TEXT NOT NULL,
  portal_domain TEXT                      -- e.g. portal.rgmlentertainment.com (fill in once decided)
);

INSERT INTO brands (slug, display_name) VALUES
  ('rgml', 'RGML Entertainment'),
  ('grinbear', 'Grin + Bear Booth'),
  ('myplanningportal', 'myplanningportal (internal/unbranded)');

-- ---------------------------------------------------------------------------
-- Customers: account holders who can log in and see their own bookings.
-- Brand-agnostic on purpose -- which portal they land in is driven by their
-- booking's brand_id, not a fixed field on the account.
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  first_name    TEXT,
  last_name     TEXT,
  password_hash TEXT,                     -- unused for now -- customers log in via magic link
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time-use magic link tokens emailed to customers. A row here that is
-- unused and unexpired is a valid login link waiting to be clicked.
CREATE TABLE customer_login_tokens (
  token       TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_customer_login_tokens_customer ON customer_login_tokens(customer_id);

-- Active login sessions for customers, once a magic link has been clicked.
-- Same shape as staff_sessions but kept separate so a leaked customer
-- session can never be mistaken for staff access.
CREATE TABLE customer_sessions (
  token       TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_customer_sessions_customer ON customer_sessions(customer_id);

-- ---------------------------------------------------------------------------
-- Staff: internal team members. Separate from customers -- staff can see
-- across all brands, customers can only see their own bookings.
-- ---------------------------------------------------------------------------
CREATE TABLE staff (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,                     -- format: '<saltHex>:<hashHex>', PBKDF2-SHA256
  first_name    TEXT,
  last_name     TEXT,
  role          TEXT NOT NULL DEFAULT 'attendant',  -- 'admin' | 'attendant' | 'dj'
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Active login sessions for staff. A row here is a valid logged-in session;
-- deleting the row (or letting it pass expires_at) logs it out.
CREATE TABLE staff_sessions (
  token       TEXT PRIMARY KEY,
  staff_id    INTEGER NOT NULL REFERENCES staff(id),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_staff_sessions_staff ON staff_sessions(staff_id);

-- ---------------------------------------------------------------------------
-- Equipment: every individually trackable physical item (not just a quantity
-- count) so each one has its own calendar. Placeholder categories/rows below
-- -- swap in the real inventory whenever it's ready.
-- ---------------------------------------------------------------------------
CREATE TABLE equipment (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,            -- e.g. 'Studio Booth #1', 'DJ Rig A'
  category      TEXT NOT NULL,            -- 'dj_gear' | 'photo_booth' | 'backdrop' | 'other'
  notes         TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1
);

-- Placeholder rows -- replace/expand once the real inventory list exists.
INSERT INTO equipment (name, category) VALUES
  ('DJ Rig A', 'dj_gear'),
  ('Studio Booth #1', 'photo_booth'),
  ('Social Booth #1', 'photo_booth'),
  ('Floral Wall Backdrop', 'backdrop'),
  ('Stretch Fabric Backdrop', 'backdrop');

-- ---------------------------------------------------------------------------
-- Packages: the actual bookable, priced offerings (what shows up on the
-- site/app for a customer to choose, and what staff manage through the
-- admin screens -- no SQL required to add one or change a price).
-- ---------------------------------------------------------------------------
CREATE TABLE packages (
  id              INTEGER PRIMARY KEY,
  brand_id        INTEGER REFERENCES brands(id),   -- null = offered under any brand
  name            TEXT NOT NULL,                    -- e.g. 'Studio Booth -- 3 Hour Package'
  category        TEXT,                             -- 'dj' | 'photo_booth' | 'bundle' | etc
  price           REAL NOT NULL,
  duration_hours  REAL,
  description     TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which equipment a package includes by default (used to pre-fill
-- booking_equipment when a customer books this package).
CREATE TABLE package_equipment (
  package_id    INTEGER NOT NULL REFERENCES packages(id),
  equipment_id  INTEGER NOT NULL REFERENCES equipment(id),
  PRIMARY KEY (package_id, equipment_id)
);

-- Placeholder packages -- replace/expand through the admin screens once built.
INSERT INTO packages (brand_id, name, category, price, duration_hours, description) VALUES
  (2, 'Studio Booth -- 3 Hour Package', 'photo_booth', 1800, 3, 'Attended print photo booth with backdrop and prints.'),
  (2, 'Social Booth -- Full Event', 'photo_booth', 900, NULL, 'Drop-off digital-only photo booth for the whole event.'),
  (1, 'DJ Entertainment -- Standard', 'dj', 1500, 4, 'DJ services for corporate and private events.');

-- ---------------------------------------------------------------------------
-- Bookings: the core record. brand_id says which portal it came through;
-- everything else (equipment/staff assignment) is what actually drives
-- conflict checking across brands. package_id links back to the priced
-- offering, but package_total is stored separately as a snapshot of what
-- was actually charged, since package prices can change later.
-- ---------------------------------------------------------------------------
CREATE TABLE bookings (
  id              INTEGER PRIMARY KEY,
  brand_id        INTEGER NOT NULL REFERENCES brands(id),
  customer_id     INTEGER REFERENCES customers(id),
  package_id      INTEGER REFERENCES packages(id),
  event_date      TEXT NOT NULL,          -- ISO date, e.g. '2026-09-12'
  event_type      TEXT,                   -- 'wedding' | 'corporate' | 'gala' | 'school' | etc
  status          TEXT NOT NULL DEFAULT 'inquiry',  -- 'inquiry'|'booked'|'completed'|'cancelled'
  package_total   REAL NOT NULL DEFAULT 0,
  deposit_paid    REAL NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which equipment is reserved for which booking (many-to-many).
CREATE TABLE booking_equipment (
  booking_id    INTEGER NOT NULL REFERENCES bookings(id),
  equipment_id  INTEGER NOT NULL REFERENCES equipment(id),
  PRIMARY KEY (booking_id, equipment_id)
);

-- Which staff are assigned to which booking (many-to-many).
CREATE TABLE booking_staff (
  booking_id    INTEGER NOT NULL REFERENCES bookings(id),
  staff_id      INTEGER NOT NULL REFERENCES staff(id),
  PRIMARY KEY (booking_id, staff_id)
);

-- ---------------------------------------------------------------------------
-- Payments: one row per Square transaction against a booking's balance.
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id                INTEGER PRIMARY KEY,
  booking_id        INTEGER NOT NULL REFERENCES bookings(id),
  amount            REAL NOT NULL,
  square_payment_id TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'completed'|'failed'|'refunded'
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Indexes that matter most: looking up everything happening on a given date,
-- and whether a specific piece of equipment or staff member is free.
-- ---------------------------------------------------------------------------
CREATE INDEX idx_bookings_event_date ON bookings(event_date);
CREATE INDEX idx_bookings_customer ON bookings(customer_id);
CREATE INDEX idx_booking_equipment_equipment ON booking_equipment(equipment_id);
CREATE INDEX idx_booking_staff_staff ON booking_staff(staff_id);
