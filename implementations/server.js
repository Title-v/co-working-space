require('dotenv').config({ path: ['.env.local', '.env'] });
const express = require('express');
const postgres = require('postgres');
const bcrypt = require('bcryptjs');
const path = require('path');
const { encrypt, decrypt } = require('./lib/crypto');
const { requireRole } = require('./lib/auth');
const { startExpiryJob } = require('./lib/expiry');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database connection
let sql;
if (process.env.DATABASE_URL) {
  // The pooler can retain named statements across app restarts and schema changes.
  sql = postgres(process.env.DATABASE_URL, { prepare: false });
}

// Getter for lazy sql access (used by middleware registered at load time)
const getSql = () => sql;
getSql._isGetter = true;

// Allow tests to inject a mock sql
function setSql(mockSql) {
  sql = mockSql;
}

// ── Pricing ──
const PRICING = {
  day: 15,
  month: 299,
  year: 2999
};

// ── Time Slots ──
const TIME_SLOTS = [
  { label: '08:00 - 10:00', startTime: '08:00', endTime: '10:00' },
  { label: '10:00 - 12:00', startTime: '10:00', endTime: '12:00' },
  { label: '12:00 - 14:00', startTime: '12:00', endTime: '14:00' },
  { label: '14:00 - 16:00', startTime: '14:00', endTime: '16:00' },
  { label: '16:00 - 18:00', startTime: '16:00', endTime: '18:00' },
  { label: 'Full Day (08:00 - 18:00)', startTime: '08:00', endTime: '18:00' }
];

const TOTAL_DESKS = 50;

// ──────────────────────────────────────────────
// Database Initialization
// ──────────────────────────────────────────────

function initDB(connection) {
  return connection.begin(async sql => {
    // Serialize first-time setup when multiple app instances start together.
    await sql`SELECT pg_advisory_xact_lock(hashtext('spacehub.init'))`;
    // Users table
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        phone TEXT NOT NULL,
        address TEXT NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'customer',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Add role column if missing (for existing DBs)
    await sql`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'customer';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `;

    // Widen columns for encrypted data (existing DBs may have VARCHAR(20))
    await sql`ALTER TABLE users ALTER COLUMN first_name TYPE TEXT`;
    await sql`ALTER TABLE users ALTER COLUMN last_name TYPE TEXT`;
    await sql`ALTER TABLE users ALTER COLUMN phone TYPE TEXT`;
    await sql`ALTER TABLE users ALTER COLUMN address TYPE TEXT`;

    // Memberships table
    await sql`
      CREATE TABLE IF NOT EXISTS memberships (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        type VARCHAR(20) NOT NULL,
        duration INTEGER NOT NULL DEFAULT 1,
        price_paid DECIMAL(10,2) NOT NULL,
        start_date DATE NOT NULL DEFAULT CURRENT_DATE,
        end_date DATE NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Payments table
    await sql`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        membership_id INTEGER REFERENCES memberships(id),
        booking_id INTEGER,
        amount DECIMAL(10,2) NOT NULL,
        payment_type VARCHAR(20) NOT NULL DEFAULT 'subscription',
        payment_method VARCHAR(30) DEFAULT 'unspecified',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Add new columns to payments if missing
    await sql`
      DO $$ BEGIN
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30) DEFAULT 'unspecified';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `;
    await sql`
      DO $$ BEGIN
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS booking_id INTEGER;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `;

    // Desks table
    await sql`
      CREATE TABLE IF NOT EXISTS desks (
        id SERIAL PRIMARY KEY,
        label VARCHAR(50) NOT NULL,
        zone VARCHAR(50) DEFAULT 'general',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Bookings table
    await sql`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        booking_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        num_desks INTEGER NOT NULL DEFAULT 1,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        payment_id INTEGER REFERENCES payments(id),
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMPTZ
      )
    `;

    // Older versions stored JavaScript's UTC expiry values without a time zone.
    await sql`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = 'bookings'::regclass AND attname = 'expires_at'
            AND atttypid = 'timestamp'::regtype
        ) THEN
          ALTER TABLE bookings ALTER COLUMN expires_at TYPE TIMESTAMPTZ
            USING expires_at AT TIME ZONE 'UTC';
        END IF;
      END $$
    `;

    // Booking-Desks junction table
    await sql`
      CREATE TABLE IF NOT EXISTS booking_desks (
        id SERIAL PRIMARY KEY,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        desk_id INTEGER NOT NULL REFERENCES desks(id),
        UNIQUE(booking_id, desk_id)
      )
    `;

    // Equipment table
    await sql`
      CREATE TABLE IF NOT EXISTS equipment (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL,
        total_quantity INTEGER NOT NULL DEFAULT 0,
        available_quantity INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Expenses table
    await sql`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        recorded_by INTEGER NOT NULL REFERENCES users(id),
        category VARCHAR(50) NOT NULL,
        description TEXT,
        amount DECIMAL(10,2) NOT NULL,
        expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Checkins table
    await sql`
      CREATE TABLE IF NOT EXISTS checkins (
        id SERIAL PRIMARY KEY,
        booking_id INTEGER NOT NULL REFERENCES bookings(id),
        checked_in_by INTEGER NOT NULL REFERENCES users(id),
        checked_in_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // ── Indexes ──
    await sql`CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(booking_date)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`;

    // ── Seed desks ──
    const deskCount = await sql`SELECT COUNT(*) as count FROM desks`;
    if (Number(deskCount[0].count) === 0) {
      for (let i = 1; i <= TOTAL_DESKS; i++) {
        const zone = i <= 20 ? 'Zone A' : i <= 40 ? 'Zone B' : 'Zone C';
        await sql`INSERT INTO desks (label, zone) VALUES (${`Desk ${i}`}, ${zone})`;
      }
      console.log('Seeded 50 desks');
    }

    // ── Seed equipment ──
    const eqCount = await sql`SELECT COUNT(*) as count FROM equipment`;
    if (Number(eqCount[0].count) === 0) {
      const items = [
        { name: 'Desks', category: 'furniture', total: 50, available: 50 },
        { name: 'Chairs', category: 'furniture', total: 60, available: 60 },
        { name: 'Extension Cords', category: 'electronics', total: 30, available: 30 },
        { name: 'Mouse', category: 'electronics', total: 20, available: 20 },
        { name: 'Keyboard', category: 'electronics', total: 20, available: 20 },
        { name: 'Water Bottles', category: 'consumable', total: 100, available: 100 },
        { name: 'Snack Packs', category: 'consumable', total: 50, available: 50 }
      ];
      for (const item of items) {
        await sql`INSERT INTO equipment (name, category, total_quantity, available_quantity) VALUES (${item.name}, ${item.category}, ${item.total}, ${item.available})`;
      }
      console.log('Seeded equipment inventory');
    }

    // ── Seed the first manager when a password is supplied ──
    const managerExists = await sql`SELECT id FROM users WHERE role = 'manager' LIMIT 1`;
    const managerPassword = process.env.INITIAL_MANAGER_PASSWORD;
    if (managerExists.length === 0 && managerPassword) {
      const salt = await bcrypt.genSalt(10);
      const hashedPw = await bcrypt.hash(managerPassword, salt);
      await sql`
        INSERT INTO users (first_name, last_name, email, phone, address, password, role)
        VALUES (${encrypt('Admin')}, ${encrypt('Manager')}, 'admin@spacehub.co', ${encrypt('000-000-0000')}, ${encrypt('SpaceHub HQ')}, ${hashedPw}, 'manager')
      `;
      console.log('Seeded initial manager account');
    }
  });
}

// ──────────────────────────────────────────────
// AUTH ROUTES
// ──────────────────────────────────────────────

// POST /api/register
app.post('/api/register', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, address, password, role } = req.body;

    if (!firstName || !lastName || !email || !phone || !address || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const userRole = role || 'customer';

    await sql`
      INSERT INTO users (first_name, last_name, email, phone, address, password, role)
      VALUES (${encrypt(firstName)}, ${encrypt(lastName)}, ${email}, ${encrypt(phone)}, ${encrypt(address)}, ${hashedPassword}, ${userRole})
    `;

    res.status(201).json({ message: 'Account created successfully!' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const users = await sql`SELECT * FROM users WHERE email = ${email}`;
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    res.json({
      message: 'Login successful!',
      user: {
        id: user.id,
        firstName: decrypt(user.first_name),
        lastName: decrypt(user.last_name),
        email: user.email,
        phone: decrypt(user.phone),
        address: decrypt(user.address),
        role: user.role || 'customer'
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ──────────────────────────────────────────────
// MEMBERSHIP ROUTES
// ──────────────────────────────────────────────

// POST /api/membership
app.post('/api/membership', async (req, res) => {
  try {
    const { userId, type, duration } = req.body;

    if (!userId || !type || !duration) {
      return res.status(400).json({ error: 'userId, type, and duration are required.' });
    }
    if (!['day', 'month', 'year'].includes(type)) {
      return res.status(400).json({ error: 'Type must be day, month, or year.' });
    }
    if (duration < 1 || !Number.isInteger(Number(duration))) {
      return res.status(400).json({ error: 'Duration must be a positive integer.' });
    }

    // Block only if there is a truly active (non-expired) membership using Bangkok timezone
    const activeExisting = await sql`
      SELECT id FROM memberships
      WHERE user_id = ${userId}
        AND status = 'active'
        AND end_date >= (NOW() AT TIME ZONE 'Asia/Bangkok')::date
    `;
    if (activeExisting.length > 0) {
      return res.status(409).json({ error: 'You already have an active membership. It must expire before you can renew.' });
    }

    // Auto-cancel any abandoned pending_payment or expired active memberships
    await sql`
      UPDATE memberships SET status = 'cancelled'
      WHERE user_id = ${userId}
        AND (
          status = 'pending_payment'
          OR (status = 'active' AND end_date < (NOW() AT TIME ZONE 'Asia/Bangkok')::date)
        )
    `;

    const unitPrice = PRICING[type];
    const totalPrice = unitPrice * Number(duration);

    const membership = await sql`
      INSERT INTO memberships (user_id, type, duration, price_paid, status, end_date)
      VALUES (${userId}, ${type}, ${Number(duration)}, ${totalPrice}, 'pending_payment',
              CURRENT_DATE + ${type === 'day' ? sql`CAST(${Number(duration)} || ' days' AS INTERVAL)` :
        type === 'month' ? sql`CAST(${Number(duration)} || ' months' AS INTERVAL)` :
          sql`CAST(${Number(duration)} || ' years' AS INTERVAL)`})
      RETURNING *
    `;

    res.status(201).json({
      message: 'Membership created. Please complete payment.',
      membership: membership[0]
    });
  } catch (err) {
    console.error('Membership error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// POST /api/membership/:membershipId/pay
app.post('/api/membership/:membershipId/pay', async (req, res) => {
  try {
    const { membershipId } = req.params;
    const { userId, paymentMethod } = req.body;

    if (!userId || !paymentMethod) {
      return res.status(400).json({ error: 'userId and paymentMethod are required.' });
    }
    if (!['credit_card', 'bank_transfer', 'truewallet'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method.' });
    }

    const memberships = await sql`
      SELECT * FROM memberships WHERE id = ${membershipId} AND user_id = ${userId}
    `;
    if (memberships.length === 0) {
      return res.status(404).json({ error: 'Membership not found.' });
    }
    const membership = memberships[0];

    if (membership.status !== 'pending_payment') {
      return res.status(400).json({ error: 'Membership is not pending payment.' });
    }

    // Simulate bank transfer delay
    if (paymentMethod === 'bank_transfer') {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    const amount = Number(membership.price_paid);

    const payment = await sql`
      INSERT INTO payments (user_id, membership_id, amount, payment_type, payment_method)
      VALUES (${userId}, ${membershipId}, ${amount}, 'subscription', ${paymentMethod})
      RETURNING *
    `;

    await sql`
      UPDATE memberships SET status = 'active' WHERE id = ${membershipId}
    `;

    res.json({
      message: 'Membership payment successful! Your membership is now active.',
      membership: { ...membership, status: 'active' },
      payment: payment[0]
    });
  } catch (err) {
    console.error('Membership payment error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// GET /api/membership/:userId
app.get('/api/membership/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const memberships = await sql`
      SELECT * FROM memberships WHERE user_id = ${userId}
      ORDER BY
        CASE status
          WHEN 'pending_payment' THEN 1
          WHEN 'active' THEN 2
          ELSE 3
        END,
        end_date DESC,
        created_at DESC
      LIMIT 1
    `;
    const payments = await sql`
      SELECT * FROM payments WHERE user_id = ${userId} ORDER BY created_at DESC
    `;
    res.json({
      membership: memberships.length > 0 ? memberships[0] : null,
      payments
    });
  } catch (err) {
    console.error('Get membership error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// GET /api/pricing
app.get('/api/pricing', (req, res) => res.json(PRICING));

// GET /api/timeslots
app.get('/api/timeslots', (req, res) => res.json(TIME_SLOTS));

// ──────────────────────────────────────────────
// BOOKING ROUTES
// ──────────────────────────────────────────────

// GET /api/bookings/availability?date=YYYY-MM-DD
app.get('/api/bookings/availability', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'Date is required.' });

    const slots = [];
    for (const slot of TIME_SLOTS) {
      const booked = await sql`
        SELECT COUNT(DISTINCT bd.desk_id) as booked_count
        FROM bookings b
        JOIN booking_desks bd ON bd.booking_id = b.id
        WHERE b.booking_date = ${date}
          AND b.status IN ('pending', 'confirmed', 'checked_in')
          AND b.start_time < ${slot.endTime}::time
          AND b.end_time > ${slot.startTime}::time
      `;
      const bookedCount = Number(booked[0].booked_count);
      slots.push({ ...slot, totalDesks: TOTAL_DESKS, availableDesks: TOTAL_DESKS - bookedCount, bookedDesks: bookedCount });
    }
    res.json({ date, slots });
  } catch (err) {
    console.error('Availability error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// POST /api/bookings
app.post('/api/bookings', async (req, res) => {
  try {
    const { userId, date, startTime, endTime, numDesks } = req.body;
    if (!userId || !date || !startTime || !endTime || !numDesks) {
      return res.status(400).json({ error: 'All booking fields are required.' });
    }

    const membership = await sql`
      SELECT id FROM memberships
      WHERE user_id = ${userId} AND status = 'active' AND end_date >= (NOW() AT TIME ZONE 'Asia/Bangkok')::date
    `;
    if (membership.length === 0) {
      return res.status(400).json({ error: 'Active membership required to book.' });
    }

    const bookedDeskIds = await sql`
      SELECT DISTINCT bd.desk_id
      FROM bookings b JOIN booking_desks bd ON bd.booking_id = b.id
      WHERE b.booking_date = ${date}
        AND b.status IN ('pending', 'confirmed', 'checked_in')
        AND b.start_time < ${endTime}::time
        AND b.end_time > ${startTime}::time
    `;
    const bookedIds = bookedDeskIds.map(r => r.desk_id);

    let availableDesks;
    if (bookedIds.length > 0) {
      availableDesks = await sql`
        SELECT id, label FROM desks WHERE is_active = TRUE AND id NOT IN ${sql(bookedIds)} ORDER BY id LIMIT ${Number(numDesks)}
      `;
    } else {
      availableDesks = await sql`
        SELECT id, label FROM desks WHERE is_active = TRUE ORDER BY id LIMIT ${Number(numDesks)}
      `;
    }

    if (availableDesks.length < Number(numDesks)) {
      return res.status(400).json({ error: `Not enough desks available. Only ${availableDesks.length} desk(s) free.` });
    }

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const booking = await sql`
      INSERT INTO bookings (user_id, booking_date, start_time, end_time, num_desks, status, expires_at)
      VALUES (${userId}, ${date}, ${startTime}::time, ${endTime}::time, ${Number(numDesks)}, 'pending', ${expiresAt})
      RETURNING *
    `;

    for (const desk of availableDesks) {
      await sql`INSERT INTO booking_desks (booking_id, desk_id) VALUES (${booking[0].id}, ${desk.id})`;
    }

    res.status(201).json({
      message: 'Booking created! Please complete payment within 30 minutes.',
      booking: { ...booking[0], expires_at: expiresAt.toISOString(), desks: availableDesks.map(d => d.label) }
    });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// POST /api/bookings/:bookingId/pay
app.post('/api/bookings/:bookingId/pay', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { userId, paymentMethod } = req.body;

    if (!userId || !paymentMethod) {
      return res.status(400).json({ error: 'userId and paymentMethod are required.' });
    }
    if (!['credit_card', 'bank_transfer', 'truewallet'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method.' });
    }

    const bookings = await sql`SELECT * FROM bookings WHERE id = ${bookingId} AND user_id = ${userId}`;
    if (bookings.length === 0) return res.status(404).json({ error: 'Booking not found.' });

    const booking = bookings[0];
    if (booking.status !== 'pending') {
      return res.status(400).json({ error: `Booking is ${booking.status}. Cannot pay.` });
    }
    if (booking.expires_at && new Date(booking.expires_at) <= new Date()) {
      await sql`UPDATE bookings SET status = 'expired' WHERE id = ${bookingId}`;
      return res.status(400).json({ error: 'Booking has expired. Please create a new booking.' });
    }

    if (paymentMethod === 'bank_transfer') {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    const amount = booking.num_desks * PRICING.day;

    const payment = await sql`
      INSERT INTO payments (user_id, booking_id, amount, payment_type, payment_method)
      VALUES (${userId}, ${bookingId}, ${amount}, 'booking', ${paymentMethod})
      RETURNING *
    `;

    await sql`
      UPDATE bookings SET status = 'confirmed', payment_id = ${payment[0].id}, expires_at = NULL WHERE id = ${bookingId}
    `;

    res.json({
      message: 'Payment confirmed! Your booking is now confirmed.',
      booking: { ...booking, status: 'confirmed' },
      payment: payment[0]
    });
  } catch (err) {
    console.error('Booking payment error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/bookings/user/:userId
app.get('/api/bookings/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const bookings = await sql`
      SELECT b.*,
        COALESCE(
          (SELECT json_agg(json_build_object('id', d.id, 'label', d.label))
           FROM booking_desks bd JOIN desks d ON d.id = bd.desk_id
           WHERE bd.booking_id = b.id), '[]'
        ) as desks,
        (SELECT checked_in_at FROM checkins WHERE booking_id = b.id LIMIT 1) as checked_in_at
      FROM bookings b WHERE b.user_id = ${userId}
      ORDER BY b.booking_date DESC, b.start_time DESC
    `;
    const result = bookings.map(b => ({
      ...b,
      expires_at: b.expires_at ? new Date(b.expires_at).toISOString() : null
    }));
    res.json({ bookings: result });
  } catch (err) {
    console.error('Get bookings error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// POST /api/bookings/:bookingId/cancel
app.post('/api/bookings/:bookingId/cancel', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { userId } = req.body;

    const bookings = await sql`SELECT * FROM bookings WHERE id = ${bookingId} AND user_id = ${userId}`;
    if (bookings.length === 0) return res.status(404).json({ error: 'Booking not found.' });

    const booking = bookings[0];
    if (booking.status === 'cancelled' || booking.status === 'expired') {
      return res.status(400).json({ error: `Booking is already ${booking.status}.` });
    }

    // Pending (unpaid) bookings can always be cancelled
    // Confirmed (paid) bookings require 1+ day notice for refund
    let refundEligible = false;
    if (booking.status === 'confirmed') {
      const bookingDate = new Date(booking.booking_date);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);

      if (bookingDate < tomorrow) {
        return res.status(400).json({ error: 'Cannot cancel less than 1 day before the reservation. No refund available.' });
      }
      refundEligible = true;
    }

    await sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${bookingId}`;
    res.json({ message: 'Booking cancelled successfully.', refundEligible });
  } catch (err) {
    console.error('Cancel booking error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/bookings/:bookingId — fetch a single booking by ID
app.get('/api/bookings/:bookingId', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const bookings = await sql`
      SELECT * FROM bookings WHERE id = ${bookingId}
    `;
    if (bookings.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    res.json({ booking: bookings[0] });
  } catch (err) {
    console.error('Get booking error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ──────────────────────────────────────────────
// EMPLOYEE ROUTES
// ──────────────────────────────────────────────

// GET /api/employee/reservations?date=YYYY-MM-DD&userId=X
app.get('/api/employee/reservations', requireRole(getSql, 'employee', 'manager'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'Date is required.' });

    const reservations = await sql`
      SELECT b.*, u.first_name, u.last_name, u.email,
        COALESCE(
          (SELECT json_agg(json_build_object('id', d.id, 'label', d.label))
           FROM booking_desks bd JOIN desks d ON d.id = bd.desk_id
           WHERE bd.booking_id = b.id), '[]'
        ) as desks,
        (SELECT checked_in_at FROM checkins WHERE booking_id = b.id LIMIT 1) as checked_in_at
      FROM bookings b JOIN users u ON u.id = b.user_id
      WHERE b.booking_date = ${date}
      ORDER BY b.start_time
    `;

    const decrypted = reservations.map(r => ({
      ...r, first_name: decrypt(r.first_name), last_name: decrypt(r.last_name)
    }));

    res.json({ reservations: decrypted });
  } catch (err) {
    console.error('Employee reservations error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// POST /api/employee/checkin
app.post('/api/employee/checkin', requireRole(getSql, 'employee', 'manager'), async (req, res) => {
  try {
    const { bookingId, employeeId } = req.body;
    const bookings = await sql`SELECT * FROM bookings WHERE id = ${bookingId}`;
    if (bookings.length === 0) return res.status(404).json({ error: 'Booking not found.' });

    if (bookings[0].status !== 'confirmed') {
      return res.status(400).json({ error: `Booking status is '${bookings[0].status}'. Must be confirmed to check in.` });
    }

    await sql`INSERT INTO checkins (booking_id, checked_in_by) VALUES (${bookingId}, ${employeeId})`;
    await sql`UPDATE bookings SET status = 'checked_in' WHERE id = ${bookingId}`;
    res.json({ message: 'Customer checked in successfully.' });
  } catch (err) {
    console.error('Checkin error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/employee/equipment
app.get('/api/employee/equipment', requireRole(getSql, 'employee', 'manager'), async (req, res) => {
  try {
    const equipment = await sql`SELECT * FROM equipment ORDER BY category, name`;
    res.json({ equipment });
  } catch (err) {
    console.error('Equipment error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// PUT /api/employee/equipment/:equipmentId
app.put('/api/employee/equipment/:equipmentId', requireRole(getSql, 'employee', 'manager'), async (req, res) => {
  try {
    const { equipmentId } = req.params;
    const { totalQuantity, availableQuantity } = req.body;
    const updated = await sql`
      UPDATE equipment
      SET total_quantity = COALESCE(${totalQuantity !== undefined ? totalQuantity : null}, total_quantity),
          available_quantity = COALESCE(${availableQuantity !== undefined ? availableQuantity : null}, available_quantity)
      WHERE id = ${equipmentId}
      RETURNING *
    `;
    if (updated.length === 0) return res.status(404).json({ error: 'Equipment not found.' });
    res.json({ message: 'Equipment updated.', equipment: updated[0] });
  } catch (err) {
    console.error('Update equipment error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// POST /api/employee/expenses
app.post('/api/employee/expenses', requireRole(getSql, 'employee', 'manager'), async (req, res) => {
  try {
    const { employeeId, category, description, amount, expenseDate } = req.body;
    if (!category || !amount) return res.status(400).json({ error: 'Category and amount are required.' });

    const expense = await sql`
      INSERT INTO expenses (recorded_by, category, description, amount, expense_date)
      VALUES (${employeeId}, ${category}, ${description || ''}, ${Number(amount)}, ${expenseDate || new Date().toISOString().split('T')[0]})
      RETURNING *
    `;
    res.status(201).json({ message: 'Expense recorded.', expense: expense[0] });
  } catch (err) {
    console.error('Expense error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/employee/expenses?date=YYYY-MM-DD&userId=X
app.get('/api/employee/expenses', requireRole(getSql, 'employee', 'manager'), async (req, res) => {
  try {
    const { date } = req.query;
    const whereDate = date || new Date().toISOString().split('T')[0];
    const expenses = await sql`
      SELECT e.*, u.first_name, u.last_name
      FROM expenses e JOIN users u ON u.id = e.recorded_by
      WHERE e.expense_date = ${whereDate}
      ORDER BY e.created_at DESC
    `;
    const decrypted = expenses.map(e => ({
      ...e, first_name: decrypt(e.first_name), last_name: decrypt(e.last_name)
    }));
    res.json({ expenses: decrypted });
  } catch (err) {
    console.error('Get expenses error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/employee/cctv
app.get('/api/employee/cctv', requireRole(getSql, 'employee', 'manager'), async (req, res) => {
  res.json({
    cameras: [
      { id: 1, name: 'Main Entrance', location: 'Ground Floor', status: 'online' },
      { id: 2, name: 'Lobby', location: 'Ground Floor', status: 'online' },
      { id: 3, name: 'Zone A - Open Area', location: 'Floor 1', status: 'online' },
      { id: 4, name: 'Zone B - Open Area', location: 'Floor 2', status: 'online' },
      { id: 5, name: 'Zone C - Meeting Rooms', location: 'Floor 3', status: 'online' },
      { id: 6, name: 'Parking Lot', location: 'Basement', status: 'offline' }
    ]
  });
});

// ──────────────────────────────────────────────
// MANAGER ROUTES
// ──────────────────────────────────────────────

// GET /api/manager/revenue?period=day&date=YYYY-MM-DD or ?period=month&month=YYYY-MM&userId=X
app.get('/api/manager/revenue', requireRole(getSql, 'manager'), async (req, res) => {
  try {
    const { period, date, month } = req.query;
    if (period === 'day' && date) {
      const breakdown = await sql`
        SELECT payment_type, payment_method, SUM(amount) as total, COUNT(*) as count
        FROM payments WHERE created_at::date = ${date} GROUP BY payment_type, payment_method
      `;
      const totalRow = await sql`
        SELECT COALESCE(SUM(amount), 0) as total_revenue, COUNT(*) as payment_count
        FROM payments WHERE created_at::date = ${date}
      `;
      res.json({ period: 'day', date, ...totalRow[0], breakdown });
    } else if (period === 'month' && month) {
      const breakdown = await sql`
        SELECT payment_type, payment_method, SUM(amount) as total, COUNT(*) as count
        FROM payments WHERE to_char(created_at, 'YYYY-MM') = ${month} GROUP BY payment_type, payment_method
      `;
      const totalRow = await sql`
        SELECT COALESCE(SUM(amount), 0) as total_revenue, COUNT(*) as payment_count
        FROM payments WHERE to_char(created_at, 'YYYY-MM') = ${month}
      `;
      res.json({ period: 'month', month, ...totalRow[0], breakdown });
    } else {
      return res.status(400).json({ error: 'Provide period=day&date=YYYY-MM-DD or period=month&month=YYYY-MM' });
    }
  } catch (err) {
    console.error('Revenue error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/manager/report?month=YYYY-MM&userId=X
app.get('/api/manager/report', requireRole(getSql, 'manager'), async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'Month (YYYY-MM) is required.' });

    const revenue = await sql`SELECT COALESCE(SUM(amount), 0) as total_revenue FROM payments WHERE to_char(created_at, 'YYYY-MM') = ${month}`;
    const expenseTotal = await sql`SELECT COALESCE(SUM(amount), 0) as total_expenses FROM expenses WHERE to_char(expense_date, 'YYYY-MM') = ${month}`;
    const dailyRevenue = await sql`
      SELECT created_at::date as date, SUM(amount) as revenue, COUNT(*) as payments
      FROM payments WHERE to_char(created_at, 'YYYY-MM') = ${month} GROUP BY created_at::date ORDER BY date
    `;
    const dailyExpenses = await sql`
      SELECT expense_date as date, SUM(amount) as expenses
      FROM expenses WHERE to_char(expense_date, 'YYYY-MM') = ${month} GROUP BY expense_date ORDER BY date
    `;
    const dailyBookings = await sql`
      SELECT booking_date as date, COUNT(*) as booking_count
      FROM bookings WHERE to_char(booking_date, 'YYYY-MM') = ${month} AND status IN ('confirmed', 'checked_in')
      GROUP BY booking_date ORDER BY date
    `;

    const totalRevenue = Number(revenue[0].total_revenue);
    const totalExpenses = Number(expenseTotal[0].total_expenses);

    res.json({ month, totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses, dailyRevenue, dailyExpenses, dailyBookings });
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/manager/employees?userId=X
app.get('/api/manager/employees', requireRole(getSql, 'manager'), async (req, res) => {
  try {
    const employees = await sql`
      SELECT id, first_name, last_name, email, phone, address, role, created_at
      FROM users WHERE role = 'employee' ORDER BY created_at DESC
    `;
    const decrypted = employees.map(e => ({
      ...e, first_name: decrypt(e.first_name), last_name: decrypt(e.last_name),
      phone: decrypt(e.phone), address: decrypt(e.address)
    }));
    res.json({ employees: decrypted });
  } catch (err) {
    console.error('Get employees error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// POST /api/manager/employees
app.post('/api/manager/employees', requireRole(getSql, 'manager'), async (req, res) => {
  try {
    const { firstName, lastName, email, phone, address, password } = req.body;
    if (!firstName || !lastName || !email || !phone || !address || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length > 0) return res.status(409).json({ error: 'An account with this email already exists.' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const employee = await sql`
      INSERT INTO users (first_name, last_name, email, phone, address, password, role)
      VALUES (${encrypt(firstName)}, ${encrypt(lastName)}, ${email}, ${encrypt(phone)}, ${encrypt(address)}, ${hashedPassword}, 'employee')
      RETURNING id, email
    `;
    res.status(201).json({ message: 'Employee created.', employee: employee[0] });
  } catch (err) {
    console.error('Create employee error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// PUT /api/manager/employees/:employeeId
app.put('/api/manager/employees/:employeeId', requireRole(getSql, 'manager'), async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { firstName, lastName, email, phone, address } = req.body;
    const emp = await sql`SELECT id FROM users WHERE id = ${employeeId} AND role = 'employee'`;
    if (emp.length === 0) return res.status(404).json({ error: 'Employee not found.' });

    await sql`
      UPDATE users SET
        first_name = COALESCE(${firstName ? encrypt(firstName) : null}, first_name),
        last_name = COALESCE(${lastName ? encrypt(lastName) : null}, last_name),
        email = COALESCE(${email || null}, email),
        phone = COALESCE(${phone ? encrypt(phone) : null}, phone),
        address = COALESCE(${address ? encrypt(address) : null}, address)
      WHERE id = ${employeeId}
    `;
    res.json({ message: 'Employee updated.' });
  } catch (err) {
    console.error('Update employee error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// DELETE /api/manager/employees/:employeeId
app.delete('/api/manager/employees/:employeeId', requireRole(getSql, 'manager'), async (req, res) => {
  try {
    const { employeeId } = req.params;
    const result = await sql`DELETE FROM users WHERE id = ${employeeId} AND role = 'employee' RETURNING id`;
    if (result.length === 0) return res.status(404).json({ error: 'Employee not found.' });
    res.json({ message: 'Employee removed.' });
  } catch (err) {
    console.error('Delete employee error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/manager/summary?date=YYYY-MM-DD&userId=X
app.get('/api/manager/summary', requireRole(getSql, 'manager'), async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const bookingCount = await sql`SELECT COUNT(*) as count FROM bookings WHERE booking_date = ${targetDate} AND status IN ('confirmed', 'checked_in')`;
    const income = await sql`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE created_at::date = ${targetDate}`;
    const expenseTotal = await sql`SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE expense_date = ${targetDate}`;
    const memberCount = await sql`SELECT COUNT(*) as count FROM users WHERE role = 'customer'`;

    res.json({
      date: targetDate,
      reservationCount: Number(bookingCount[0].count),
      totalIncome: Number(income[0].total),
      totalExpenses: Number(expenseTotal[0].total),
      netIncome: Number(income[0].total) - Number(expenseTotal[0].total),
      totalMembers: Number(memberCount[0].count)
    });
  } catch (err) {
    console.error('Summary error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Simulated Banking API ──
app.post('/api/bank/transfer', async (req, res) => {
  await new Promise(resolve => setTimeout(resolve, 1500));
  res.json({ success: true, transactionId: 'TXN' + Date.now(), message: 'Bank transfer processed successfully (simulated).' });
});

// ──────────────────────────────────────────────
// Start Server
// ──────────────────────────────────────────────
async function start() {
  if (!sql) throw new Error('DATABASE_URL is required to start SpaceHub.');
  if (!/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY || '')) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string.');
  }

  const schemaConnection = process.env.DATABASE_URL_UNPOOLED
    ? postgres(process.env.DATABASE_URL_UNPOOLED, { max: 1 })
    : sql;
  try {
    await initDB(schemaConnection);
  } finally {
    if (schemaConnection !== sql) await schemaConnection.end();
  }
  console.log('Database initialized — all tables ready');
  startExpiryJob(sql);
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  start().catch(err => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
}

module.exports = { app, setSql };
