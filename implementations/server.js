require('dotenv').config({ path: ['.env.local', '.env'] });
const express = require('express');
const postgres = require('postgres');
const bcrypt = require('bcryptjs');
const path = require('path');
const { encrypt, decrypt } = require('./lib/crypto');
const { authenticated, sessionUser, signIn, signOut } = require('./lib/auth');
const { bookingRoutes, slots, bookingWindow } = require('./lib/bookings');
const { startExpiryJob } = require('./lib/expiry');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.SPACEHUB_HOST || '127.0.0.1';

// Middleware
app.disable('x-powered-by');
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '32kb' }));
app.get('/booking.html', (req, res) => res.redirect('/#reserve'));
app.get('/dashboard.html', (req, res) => res.redirect('/my-bookings.html'));
app.use(express.static(path.join(__dirname, 'public')));

// Database connection
let sql;
if (process.env.DATABASE_URL) {
  // The pooler can retain named statements across app restarts and schema changes.
  sql = postgres(process.env.DATABASE_URL, { prepare: false });
}

// Getter for lazy sql access (used by middleware registered at load time)
const getSql = () => sql;


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

    await sql`CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash CHAR(64) PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_web_sessions_expiry ON web_sessions(expires_at)`;

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

    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_baht NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS request_key UUID`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_request ON bookings(user_id, request_key) WHERE request_key IS NOT NULL`;

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

    // Keep the existing desk IDs and reservations when naming the original rooms.
    await sql`UPDATE desks SET zone = CASE zone
      WHEN 'Zone A' THEN 'ห้องแสงเช้า' WHEN 'Zone B' THEN 'ห้องร่มไทร' ELSE 'ห้องลานฟ้า' END
      WHERE zone IN ('Zone A', 'Zone B', 'Zone C')`;
    await sql`UPDATE bookings b SET total_baht=COALESCE(
      (SELECT p.amount FROM payments p WHERE p.id=b.payment_id), b.num_desks * ${PRICING.day}::integer
    ) WHERE b.total_baht IS NULL`;

    // ── Seed desks ──
    const deskCount = await sql`SELECT COUNT(*) as count FROM desks`;
    if (Number(deskCount[0].count) === 0) {
      for (let i = 1; i <= TOTAL_DESKS; i++) {
        const zone = i <= 20 ? 'ห้องแสงเช้า' : i <= 40 ? 'ห้องร่มไทร' : 'ห้องลานฟ้า';
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

function publicUser(user) {
  return { id: user.id, role: user.role, firstName: decrypt(user.first_name), lastName: decrypt(user.last_name),
    email: user.email, phone: decrypt(user.phone), address: decrypt(user.address) };
}

app.post('/api/register', async (req, res, next) => {
  try {
    const { firstName, lastName, phone, password } = req.body || {};
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (![firstName, lastName, phone].every(value => typeof value === 'string' && value.trim() && value.length <= 100) ||
        !/^\S+@\S+\.\S+$/.test(email) || email.length > 254 ||
        typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) {
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลติดต่อและรหัสผ่านอย่างน้อย 8 ตัวอักษรให้ครบ' });
    }
    const existing = await sql`SELECT id FROM users WHERE lower(email)=${email} LIMIT 1`;
    if (existing.length) return res.status(409).json({ error: 'อีเมลนี้มีบัญชีอยู่แล้ว' });
    const hash = await bcrypt.hash(password, 10);
    await sql`INSERT INTO users (first_name,last_name,email,phone,address,password,role)
      VALUES (${encrypt(firstName.trim())},${encrypt(lastName.trim())},${email},${encrypt(phone.trim())},'',${hash},'customer')`;
    res.status(201).json({ message: 'สร้างบัญชีแล้ว' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'อีเมลนี้มีบัญชีอยู่แล้ว' });
    next(err);
  }
});

app.post('/api/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'กรุณากรอกอีเมลและรหัสผ่าน' });
  }
  try {
    const [user] = await sql`SELECT * FROM users WHERE lower(email)=lower(${email.trim()})
      ORDER BY (email=${email.trim()}) DESC, id LIMIT 1`;
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    }
    const profile = publicUser(user);
    await signIn(sql, req, res, user.id);
    res.json({ user: profile });
  } catch (err) { next(err); }
});

app.get('/api/session', async (req, res, next) => {
  try {
    const user = await sessionUser(sql, req);
    res.json({ user: user ? publicUser(user) : null });
  } catch (err) { next(err); }
});
app.post('/api/logout', (req, res, next) => signOut(sql, req, res).catch(next));
app.get('/api/pricing', (req, res) => res.json(PRICING));
app.get('/api/timeslots', (req, res) => res.json(slots));
app.use('/api/bookings', bookingRoutes(getSql, PRICING.day));

// Historical membership records remain available to their owner.
app.get('/api/membership/:userId', authenticated(getSql), async (req, res, next) => {
  if (Number(req.params.userId) !== req.user.id) return res.sendStatus(403);
  try {
    const [membership] = await sql`SELECT * FROM memberships WHERE user_id=${req.user.id} ORDER BY created_at DESC, id DESC LIMIT 1`;
    const payments = await sql`SELECT * FROM payments WHERE user_id=${req.user.id} ORDER BY id DESC`;
    res.json({ membership: membership || null, payments });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────
// EMPLOYEE ROUTES
// ──────────────────────────────────────────────

// GET /api/employee/reservations?date=YYYY-MM-DD&userId=X
app.get('/api/employee/reservations', authenticated(getSql, 'employee', 'manager'), async (req, res) => {
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
app.post('/api/employee/checkin', authenticated(getSql, 'employee', 'manager'), async (req, res, next) => {
  const id = Number(req.body?.bookingId);
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) return res.status(400).json({ error: 'Invalid booking number.' });
  try {
    const checked = await sql.begin(async tx => {
      const [booking] = await tx`UPDATE bookings SET status='checked_in'
        WHERE id=${id} AND status='confirmed' AND booking_date=(now() AT TIME ZONE 'Asia/Bangkok')::date RETURNING id`;
      if (!booking) return false;
      await tx`INSERT INTO checkins (booking_id, checked_in_by) VALUES (${id}, ${req.user.id})`;
      return true;
    });
    if (!checked) return res.status(409).json({ error: 'Only a confirmed booking for today can be checked in.' });
    res.json({ message: 'Customer checked in successfully.' });
  } catch (err) { next(err); }
});

// GET /api/employee/equipment
app.get('/api/employee/equipment', authenticated(getSql, 'employee', 'manager'), async (req, res) => {
  try {
    const equipment = await sql`SELECT * FROM equipment ORDER BY category, name`;
    res.json({ equipment });
  } catch (err) {
    console.error('Equipment error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// PUT /api/employee/equipment/:equipmentId
app.put('/api/employee/equipment/:equipmentId', authenticated(getSql, 'employee', 'manager'), async (req, res) => {
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
app.post('/api/employee/expenses', authenticated(getSql, 'employee', 'manager'), async (req, res) => {
  try {
    const { category, description, amount, expenseDate } = req.body;
    const employeeId = req.user.id;
    if (!category || !amount) return res.status(400).json({ error: 'Category and amount are required.' });

    const expense = await sql`
      INSERT INTO expenses (recorded_by, category, description, amount, expense_date)
      VALUES (${employeeId}, ${category}, ${description || ''}, ${Number(amount)}, ${expenseDate || bookingWindow().today})
      RETURNING *
    `;
    res.status(201).json({ message: 'Expense recorded.', expense: expense[0] });
  } catch (err) {
    console.error('Expense error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/employee/expenses?date=YYYY-MM-DD&userId=X
app.get('/api/employee/expenses', authenticated(getSql, 'employee', 'manager'), async (req, res) => {
  try {
    const { date } = req.query;
    const whereDate = date || bookingWindow().today;
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

// MANAGER ROUTES
// ──────────────────────────────────────────────

// GET /api/manager/revenue?period=day&date=YYYY-MM-DD or ?period=month&month=YYYY-MM&userId=X
app.get('/api/manager/revenue', authenticated(getSql, 'manager'), async (req, res) => {
  try {
    const { period, date, month } = req.query;
    if (period === 'day' && date) {
      const breakdown = await sql`
        SELECT payment_type, payment_method, SUM(amount) as total, COUNT(*) as count
        FROM payments WHERE ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date = ${date} GROUP BY payment_type, payment_method
      `;
      const totalRow = await sql`
        SELECT COALESCE(SUM(amount), 0) as total_revenue, COUNT(*) as payment_count
        FROM payments WHERE ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date = ${date}
      `;
      res.json({ period: 'day', date, ...totalRow[0], breakdown });
    } else if (period === 'month' && month) {
      const breakdown = await sql`
        SELECT payment_type, payment_method, SUM(amount) as total, COUNT(*) as count
        FROM payments WHERE to_char(((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM') = ${month} GROUP BY payment_type, payment_method
      `;
      const totalRow = await sql`
        SELECT COALESCE(SUM(amount), 0) as total_revenue, COUNT(*) as payment_count
        FROM payments WHERE to_char(((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM') = ${month}
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
app.get('/api/manager/report', authenticated(getSql, 'manager'), async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'Month (YYYY-MM) is required.' });

    const revenue = await sql`SELECT COALESCE(SUM(amount), 0) as total_revenue FROM payments WHERE to_char(((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM') = ${month}`;
    const expenseTotal = await sql`SELECT COALESCE(SUM(amount), 0) as total_expenses FROM expenses WHERE to_char(expense_date, 'YYYY-MM') = ${month}`;
    const dailyRevenue = await sql`
      SELECT ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date as date, SUM(amount) as revenue, COUNT(*) as payments
      FROM payments WHERE to_char(((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM') = ${month} GROUP BY ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date ORDER BY date
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
app.get('/api/manager/employees', authenticated(getSql, 'manager'), async (req, res) => {
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
app.post('/api/manager/employees', authenticated(getSql, 'manager'), async (req, res) => {
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
app.put('/api/manager/employees/:employeeId', authenticated(getSql, 'manager'), async (req, res) => {
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
app.delete('/api/manager/employees/:employeeId', authenticated(getSql, 'manager'), async (req, res) => {
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
app.get('/api/manager/summary', authenticated(getSql, 'manager'), async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date || bookingWindow().today;

    const bookingCount = await sql`SELECT COUNT(*) as count FROM bookings WHERE booking_date = ${targetDate} AND status IN ('confirmed', 'checked_in')`;
    const income = await sql`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date = ${targetDate}`;
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

app.use('/api', (req, res) => res.status(404).json({ error: 'ไม่พบ API นี้' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'ข้อมูล JSON ไม่ถูกต้อง' });
  console.error('Request failed', req.method, req.path, err.code || err.name);
  res.status(500).json({ error: 'บันทึกรายการไม่สำเร็จ กรุณาลองอีกครั้ง' });
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
  app.listen(PORT, HOST, () => {
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
