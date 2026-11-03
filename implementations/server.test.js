const request = require('supertest');
const bcrypt = require('bcryptjs');

// Mock external dependencies before importing server.js
const mockSql = jest.fn((strings, ...values) => {
    return Promise.resolve([]);
});

jest.mock('postgres', () => {
    return jest.fn(() => mockSql);
});

jest.mock('./lib/crypto', () => ({
    encrypt: jest.fn(text => `enc:${text}`),
    decrypt: jest.fn(text => text.replace('enc:', ''))
}));

jest.mock('./lib/expiry', () => ({
    startExpiryJob: jest.fn()
}));

const { app, setSql } = require('./server');

// Helper: mock auth middleware to pass as a given role
const mockAsRole = (role) => {
    mockSql.mockResolvedValueOnce([{ role }]); // requireRole user lookup
};

describe('server.js API Routes - Core Business Logic Testing', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        mockSql.mockResolvedValue([]);
        setSql(mockSql);
    });

    // ─────────────────────────────────────────────────────────────
    // Authentication & Registration
    // ─────────────────────────────────────────────────────────────
    describe('Authentication & Registration (`POST /api/register`)', () => {
        it('should reject registration if required fields (e.g., email, password) are missing', async () => {
            const res = await request(app)
                .post('/api/register')
                .send({ firstName: 'Test' });

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('All fields are required.');
        });

        it('should successfully register a user and encrypt sensitive data', async () => {
            mockSql.mockResolvedValueOnce([]); // email uniqueness check passes

            const res = await request(app)
                .post('/api/register')
                .send({
                    firstName: 'John',
                    lastName: 'Doe',
                    email: 'john@example.com',
                    phone: '1234567890',
                    address: '123 Main St',
                    password: 'testPassword123'
                });

            expect(res.statusCode).toBe(201);
            expect(res.body.message).toBe('Account created successfully!');
            expect(mockSql).toHaveBeenCalledTimes(2);
        });

        it('should reject registration if the email already exists in the database', async () => {
            mockSql.mockResolvedValueOnce([{ id: 1 }]);

            const res = await request(app)
                .post('/api/register')
                .send({
                    firstName: 'John',
                    lastName: 'Doe',
                    email: 'john@example.com',
                    phone: '1234567890',
                    address: '123 Main St',
                    password: 'testPassword123'
                });

            expect(res.statusCode).toBe(409);
            expect(res.body.error).toBe('An account with this email already exists.');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Login
    // ─────────────────────────────────────────────────────────────
    describe('Login (`POST /api/login`)', () => {
        it('should reject login if email or password are missing', async () => {
            const res = await request(app)
                .post('/api/login')
                .send({ email: 'test@example.com' });

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('Email and password are required.');
        });

        it('should reject login if the email does not exist', async () => {
            mockSql.mockResolvedValueOnce([]);

            const res = await request(app)
                .post('/api/login')
                .send({ email: 'nobody@example.com', password: 'pass123' });

            expect(res.statusCode).toBe(401);
            expect(res.body.error).toBe('Invalid email or password.');
        });

        it('should reject login if the password is incorrect', async () => {
            const hashedPassword = await bcrypt.hash('correctPassword', 10);
            mockSql.mockResolvedValueOnce([{
                id: 1, first_name: 'enc:John', last_name: 'enc:Doe',
                email: 'john@example.com', phone: 'enc:123', address: 'enc:addr',
                password: hashedPassword, role: 'customer'
            }]);

            const res = await request(app)
                .post('/api/login')
                .send({ email: 'john@example.com', password: 'wrongPassword' });

            expect(res.statusCode).toBe(401);
            expect(res.body.error).toBe('Invalid email or password.');
        });

        it('should successfully login with correct credentials', async () => {
            const hashedPassword = await bcrypt.hash('testPassword123', 10);
            mockSql.mockResolvedValueOnce([{
                id: 1, first_name: 'enc:John', last_name: 'enc:Doe',
                email: 'john@example.com', phone: 'enc:123', address: 'enc:addr',
                password: hashedPassword, role: 'customer'
            }]);

            const res = await request(app)
                .post('/api/login')
                .send({ email: 'john@example.com', password: 'testPassword123' });

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Login successful!');
            expect(res.body.user.email).toBe('john@example.com');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Utility Endpoints
    // ─────────────────────────────────────────────────────────────
    describe('Utility Endpoints', () => {
        it('GET /api/pricing should return pricing object', async () => {
            const res = await request(app).get('/api/pricing');
            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveProperty('day', 15);
            expect(res.body).toHaveProperty('month', 299);
            expect(res.body).toHaveProperty('year', 2999);
        });

        it('GET /api/timeslots should return array of time slots', async () => {
            const res = await request(app).get('/api/timeslots');
            expect(res.statusCode).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
            expect(res.body.length).toBeGreaterThan(0);
            expect(res.body[0]).toHaveProperty('startTime');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Membership System
    // ─────────────────────────────────────────────────────────────
    describe('Membership System (`POST /api/membership`)', () => {
        it('should reject membership creation with invalid duration boundaries', async () => {
            const res = await request(app)
                .post('/api/membership')
                .send({ userId: 1, type: 'decade', duration: 1 });

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('Type must be day, month, or year.');
        });

        it('should reject if userId, type, or duration are missing', async () => {
            const res = await request(app)
                .post('/api/membership')
                .send({ type: 'day' });

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('userId, type, and duration are required.');
        });

        it('should prevent purchasing a membership if the user already has an active one', async () => {
            mockSql.mockResolvedValueOnce([{ id: 10 }]);

            const res = await request(app)
                .post('/api/membership')
                .send({ userId: 1, type: 'month', duration: 1 });

            expect(res.statusCode).toBe(409);
            expect(res.body.error).toBe('You already have an active membership. It must expire before you can renew.');
        });

        it('should successfully create a membership in pending_payment state', async () => {
            mockSql
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: 5, status: 'pending_payment' }]);

            const res = await request(app)
                .post('/api/membership')
                .send({ userId: 2, type: 'month', duration: 2 });

            expect(res.statusCode).toBe(201);
            expect(res.body.message).toBe('Membership created. Please complete payment.');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // GET Membership
    // ─────────────────────────────────────────────────────────────
    describe('Get Membership (`GET /api/membership/:userId`)', () => {
        it('should return null membership when user has no membership', async () => {
            mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
            const res = await request(app).get('/api/membership/1');
            expect(res.statusCode).toBe(200);
            expect(res.body.membership).toBeNull();
        });

        it('should return membership and payment history when they exist', async () => {
            mockSql
                .mockResolvedValueOnce([{ id: 1, status: 'active', type: 'month' }])
                .mockResolvedValueOnce([{ id: 1, amount: 299 }]);
            const res = await request(app).get('/api/membership/1');
            expect(res.statusCode).toBe(200);
            expect(res.body.membership.status).toBe('active');
            expect(res.body.payments.length).toBe(1);
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Membership Payment
    // ─────────────────────────────────────────────────────────────
    describe('Membership Payment (`POST /api/membership/:id/pay`)', () => {
        it('should reject if userId or paymentMethod are missing', async () => {
            const res = await request(app).post('/api/membership/1/pay').send({ userId: 1 });
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('userId and paymentMethod are required.');
        });

        it('should reject invalid payment method', async () => {
            const res = await request(app).post('/api/membership/1/pay')
                .send({ userId: 1, paymentMethod: 'bitcoin' });
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('Invalid payment method.');
        });

        it('should return 404 if membership not found', async () => {
            mockSql.mockResolvedValueOnce([]);
            const res = await request(app).post('/api/membership/99/pay')
                .send({ userId: 1, paymentMethod: 'credit_card' });
            expect(res.statusCode).toBe(404);
        });

        it('should reject payment if membership is not pending_payment', async () => {
            mockSql.mockResolvedValueOnce([{ id: 1, status: 'active', price_paid: 299 }]);
            const res = await request(app).post('/api/membership/1/pay')
                .send({ userId: 1, paymentMethod: 'credit_card' });
            expect(res.statusCode).toBe(400);
        });

        it('should successfully process membership payment', async () => {
            mockSql
                .mockResolvedValueOnce([{ id: 1, status: 'pending_payment', price_paid: 299 }])
                .mockResolvedValueOnce([{ id: 10, amount: 299 }])
                .mockResolvedValueOnce([]);
            const res = await request(app).post('/api/membership/1/pay')
                .send({ userId: 1, paymentMethod: 'credit_card' });
            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Membership payment successful! Your membership is now active.');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Desk Booking System
    // ─────────────────────────────────────────────────────────────
    describe('Desk Booking System (`POST /api/bookings`)', () => {
        it('should reject booking if required fields are missing', async () => {
            const res = await request(app).post('/api/bookings')
                .send({ userId: 1, date: '2026-10-10' });
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('All booking fields are required.');
        });

        it('should reject booking if user does not possess an active membership clearance level', async () => {
            mockSql.mockResolvedValueOnce([]);
            const res = await request(app).post('/api/bookings')
                .send({ userId: 1, date: '2026-10-10', startTime: '10:00', endTime: '12:00', numDesks: 1 });
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('Active membership required to book.');
        });

        it('should reject booking if requested number of desks exceeds available inventory at that specific time slot', async () => {
            mockSql
                .mockResolvedValueOnce([{ id: 1 }])
                .mockResolvedValueOnce([{ desk_id: 1 }, { desk_id: 2 }])
                .mockResolvedValueOnce([]);
            const res = await request(app).post('/api/bookings')
                .send({ userId: 1, date: '2026-10-10', startTime: '10:00', endTime: '12:00', numDesks: 1 });
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toContain('Not enough desks available');
        });

        it('should successfully instantiate a booking in a pending state and allocate exact desk IDs', async () => {
            mockSql
                .mockResolvedValueOnce([{ id: 1 }])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: 5, label: 'Desk 5' }])
                .mockResolvedValueOnce([{ id: 100, status: 'pending' }])
                .mockResolvedValueOnce([]);
            const res = await request(app).post('/api/bookings')
                .send({ userId: 1, date: '2026-10-10', startTime: '10:00', endTime: '12:00', numDesks: 1 });
            expect(res.statusCode).toBe(201);
            expect(res.body.booking.desks).toContain('Desk 5');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Booking Payment
    // ─────────────────────────────────────────────────────────────
    describe('Booking Payment (`POST /api/bookings/:id/pay`)', () => {
        it('should reject if userId or paymentMethod are missing', async () => {
            const res = await request(app).post('/api/bookings/1/pay').send({ userId: 1 });
            expect(res.statusCode).toBe(400);
        });

        it('should reject invalid payment method', async () => {
            const res = await request(app).post('/api/bookings/1/pay')
                .send({ userId: 1, paymentMethod: 'paypal' });
            expect(res.statusCode).toBe(400);
        });

        it('should return 404 if booking not found', async () => {
            mockSql.mockResolvedValueOnce([]);
            const res = await request(app).post('/api/bookings/99/pay')
                .send({ userId: 1, paymentMethod: 'credit_card' });
            expect(res.statusCode).toBe(404);
        });

        it('should reject payment if booking is not in pending status', async () => {
            mockSql.mockResolvedValueOnce([{ id: 1, status: 'confirmed', num_desks: 1, expires_at: null }]);
            const res = await request(app).post('/api/bookings/1/pay')
                .send({ userId: 1, paymentMethod: 'credit_card' });
            expect(res.statusCode).toBe(400);
        });

        it('should reject payment if booking has expired', async () => {
            const pastTime = new Date(Date.now() - 3600000).toISOString().replace('Z', '+00:00');
            mockSql
                .mockResolvedValueOnce([{ id: 1, status: 'pending', num_desks: 1, expires_at: pastTime }])
                .mockResolvedValueOnce([]);
            const res = await request(app).post('/api/bookings/1/pay')
                .send({ userId: 1, paymentMethod: 'credit_card' });
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('Booking has expired. Please create a new booking.');
        });

        it('should successfully process booking payment', async () => {
            const futureTime = new Date(Date.now() + 1800000).toISOString();
            mockSql
                .mockResolvedValueOnce([{ id: 1, status: 'pending', num_desks: 1, expires_at: futureTime }])
                .mockResolvedValueOnce([{ id: 20, amount: 15 }])
                .mockResolvedValueOnce([]);
            const res = await request(app).post('/api/bookings/1/pay')
                .send({ userId: 1, paymentMethod: 'credit_card' });
            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Payment confirmed! Your booking is now confirmed.');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Get Bookings
    // ─────────────────────────────────────────────────────────────
    describe('Get Bookings', () => {
        it('GET /api/bookings/user/:userId - should return empty array when no bookings', async () => {
            mockSql.mockResolvedValueOnce([]);
            const res = await request(app).get('/api/bookings/user/1');
            expect(res.statusCode).toBe(200);
            expect(res.body.bookings).toEqual([]);
        });

        it('GET /api/bookings/user/:userId - should return list of bookings', async () => {
            mockSql.mockResolvedValueOnce([
                { id: 1, booking_date: '2026-10-10', status: 'confirmed' },
                { id: 2, booking_date: '2026-10-11', status: 'pending', expires_at: '2026-10-11T09:30:00+07:00' }
            ]);
            const res = await request(app).get('/api/bookings/user/1');
            expect(res.statusCode).toBe(200);
            expect(res.body.bookings.length).toBe(2);
            expect(res.body.bookings[1].expires_at).toBe('2026-10-11T02:30:00.000Z');
        });

        it('GET /api/bookings/:bookingId - should return 404 if not found', async () => {
            mockSql.mockResolvedValueOnce([]);
            const res = await request(app).get('/api/bookings/99');
            expect(res.statusCode).toBe(404);
        });

        it('GET /api/bookings/:bookingId - should return booking details', async () => {
            mockSql.mockResolvedValueOnce([{ id: 1, status: 'confirmed' }]);
            const res = await request(app).get('/api/bookings/1');
            expect(res.statusCode).toBe(200);
            expect(res.body.booking.status).toBe('confirmed');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Cancel Booking
    // ─────────────────────────────────────────────────────────────
    describe('Cancel Booking (`POST /api/bookings/:id/cancel`)', () => {
        it('should return 404 if booking not found', async () => {
            mockSql.mockResolvedValueOnce([]);
            const res = await request(app).post('/api/bookings/99/cancel').send({ userId: 1 });
            expect(res.statusCode).toBe(404);
        });

        it('should reject cancellation if booking is already cancelled', async () => {
            mockSql.mockResolvedValueOnce([{
                id: 1, status: 'cancelled',
                booking_date: new Date(Date.now() + 86400000 * 3).toISOString()
            }]);
            const res = await request(app).post('/api/bookings/1/cancel').send({ userId: 1 });
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toContain('already cancelled');
        });

        it('should reject if booking date is less than 1 day away', async () => {
            const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
            mockSql.mockResolvedValueOnce([{ id: 1, status: 'confirmed', booking_date: yesterday }]);
            const res = await request(app).post('/api/bookings/1/cancel').send({ userId: 1 });
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toContain('Cannot cancel less than 1 day');
        });

        it('should successfully cancel a booking far enough in the future', async () => {
            const futureDate = new Date(Date.now() + 86400000 * 5).toISOString().split('T')[0];
            mockSql
                .mockResolvedValueOnce([{ id: 1, status: 'confirmed', booking_date: futureDate }])
                .mockResolvedValueOnce([]);
            const res = await request(app).post('/api/bookings/1/cancel').send({ userId: 1 });
            expect(res.statusCode).toBe(200);
            expect(res.body.refundEligible).toBe(true);
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Booking Availability
    // ─────────────────────────────────────────────────────────────
    describe('Booking Availability (`GET /api/bookings/availability`)', () => {
        it('should return 400 if date param is missing', async () => {
            const res = await request(app).get('/api/bookings/availability');
            expect(res.statusCode).toBe(400);
        });

        it('should return slot availability for a given date', async () => {
            mockSql.mockResolvedValue([{ booked_count: '5' }]);
            const res = await request(app).get('/api/bookings/availability?date=2026-10-10');
            expect(res.statusCode).toBe(200);
            expect(res.body.slots[0]).toHaveProperty('availableDesks');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Employee Routes
    // ─────────────────────────────────────────────────────────────
    describe('Employee Routes', () => {
        it('GET /api/employee/reservations - should return 401 if userId missing', async () => {
            const res = await request(app).get('/api/employee/reservations?date=2026-10-10');
            expect(res.statusCode).toBe(401);
        });

        it('GET /api/employee/reservations - should return 400 if date is missing', async () => {
            mockAsRole('employee');
            const res = await request(app).get('/api/employee/reservations?userId=1');
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('Date is required.');
        });

        it('GET /api/employee/reservations - should return reservations for date', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([
                { id: 1, first_name: 'enc:John', last_name: 'enc:Doe', booking_date: '2026-10-10' }
            ]);
            const res = await request(app).get('/api/employee/reservations?date=2026-10-10&userId=1');
            expect(res.statusCode).toBe(200);
            expect(res.body.reservations).toBeDefined();
        });

        it('POST /api/employee/checkin - should return 404 if booking not found', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([]);
            const res = await request(app).post('/api/employee/checkin')
                .send({ bookingId: 99, employeeId: 1, userId: 1 });
            expect(res.statusCode).toBe(404);
        });

        it('POST /api/employee/checkin - should reject if booking is not confirmed', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([{ id: 1, status: 'pending' }]);
            const res = await request(app).post('/api/employee/checkin')
                .send({ bookingId: 1, employeeId: 1, userId: 1 });
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toContain('Must be confirmed');
        });

        it('POST /api/employee/checkin - should successfully check in a confirmed booking', async () => {
            mockAsRole('employee');
            mockSql
                .mockResolvedValueOnce([{ id: 1, status: 'confirmed' }])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);
            const res = await request(app).post('/api/employee/checkin')
                .send({ bookingId: 1, employeeId: 1, userId: 1 });
            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Customer checked in successfully.');
        });

        it('GET /api/employee/equipment - should return equipment list', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([{ id: 1, name: 'Chairs', category: 'furniture' }]);
            const res = await request(app).get('/api/employee/equipment?userId=1');
            expect(res.statusCode).toBe(200);
            expect(res.body.equipment).toBeDefined();
        });

        it('GET /api/employee/cctv - should return camera list', async () => {
            mockAsRole('employee');
            const res = await request(app).get('/api/employee/cctv?userId=1');
            expect(res.statusCode).toBe(200);
            expect(res.body.cameras).toBeDefined();
            expect(res.body.cameras.length).toBeGreaterThan(0);
        });

        it('POST /api/employee/expenses - should reject if category or amount are missing', async () => {
            mockAsRole('employee');
            const res = await request(app).post('/api/employee/expenses')
                .send({ userId: 1, employeeId: 1 });
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('Category and amount are required.');
        });

        it('POST /api/employee/expenses - should record expense successfully', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([{ id: 1, category: 'supplies', amount: 50 }]);
            const res = await request(app).post('/api/employee/expenses')
                .send({ userId: 1, employeeId: 1, category: 'supplies', amount: 50 });
            expect(res.statusCode).toBe(201);
            expect(res.body.message).toBe('Expense recorded.');
        });

        it('GET /api/employee/expenses - should return expense list', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([
                { id: 1, first_name: 'enc:Staff', last_name: 'enc:A', category: 'supplies', amount: 50 }
            ]);
            const res = await request(app).get('/api/employee/expenses?userId=1&date=2026-10-10');
            expect(res.statusCode).toBe(200);
            expect(res.body.expenses).toBeDefined();
        });

        it('PUT /api/employee/equipment/:id - should return 404 if equipment not found', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([]); // update returns nothing
            const res = await request(app).put('/api/employee/equipment/99')
                .send({ userId: 1, totalQuantity: 10 });
            expect(res.statusCode).toBe(404);
        });

        it('PUT /api/employee/equipment/:id - should update equipment successfully', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([{ id: 1, name: 'Chairs', total_quantity: 10 }]);
            const res = await request(app).put('/api/employee/equipment/1')
                .send({ userId: 1, totalQuantity: 10, availableQuantity: 8 });
            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Equipment updated.');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Manager Routes
    // ─────────────────────────────────────────────────────────────
    describe('Manager Routes', () => {
        it('GET /api/manager/revenue - should return 400 with missing period', async () => {
            mockAsRole('manager');
            const res = await request(app).get('/api/manager/revenue?userId=1');
            expect(res.statusCode).toBe(400);
        });

        it('GET /api/manager/revenue - should return daily revenue', async () => {
            mockAsRole('manager');
            mockSql
                .mockResolvedValueOnce([{ payment_type: 'booking', payment_method: 'credit_card', total: 100, count: 2 }])
                .mockResolvedValueOnce([{ total_revenue: '100', payment_count: '2' }]);
            const res = await request(app).get('/api/manager/revenue?userId=1&period=day&date=2026-10-10');
            expect(res.statusCode).toBe(200);
            expect(res.body.period).toBe('day');
        });

        it('GET /api/manager/revenue - should return monthly revenue', async () => {
            mockAsRole('manager');
            mockSql
                .mockResolvedValueOnce([{ payment_type: 'subscription', total: 5000, count: 10 }])
                .mockResolvedValueOnce([{ total_revenue: '5000', payment_count: '10' }]);
            const res = await request(app).get('/api/manager/revenue?userId=1&period=month&month=2026-10');
            expect(res.statusCode).toBe(200);
            expect(res.body.period).toBe('month');
        });

        it('GET /api/manager/report - should reject if month is missing', async () => {
            mockAsRole('manager');
            const res = await request(app).get('/api/manager/report?userId=1');
            expect(res.statusCode).toBe(400);
        });

        it('GET /api/manager/report - should return monthly report', async () => {
            mockAsRole('manager');
            mockSql
                .mockResolvedValueOnce([{ total_revenue: '5000' }])
                .mockResolvedValueOnce([{ total_expenses: '1000' }])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);
            const res = await request(app).get('/api/manager/report?userId=1&month=2026-10');
            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveProperty('totalRevenue');
            expect(res.body).toHaveProperty('netIncome');
        });

        it('GET /api/manager/employees - should return employee list', async () => {
            mockAsRole('manager');
            mockSql.mockResolvedValueOnce([
                { id: 2, first_name: 'enc:Staff', last_name: 'enc:One', email: 'staff@x.com', phone: 'enc:000', address: 'enc:addr', role: 'employee' }
            ]);
            const res = await request(app).get('/api/manager/employees?userId=1');
            expect(res.statusCode).toBe(200);
            expect(res.body.employees).toBeDefined();
        });

        it('POST /api/manager/employees - should reject if fields missing', async () => {
            mockAsRole('manager');
            const res = await request(app).post('/api/manager/employees')
                .send({ userId: 1, firstName: 'Staff' });
            expect(res.statusCode).toBe(400);
        });

        it('POST /api/manager/employees - should create employee successfully', async () => {
            mockAsRole('manager');
            mockSql
                .mockResolvedValueOnce([]) // email check
                .mockResolvedValueOnce([{ id: 5, email: 'staff@x.com' }]); // insert
            const res = await request(app).post('/api/manager/employees')
                .send({ userId: 1, firstName: 'Staff', lastName: 'One', email: 'staff@x.com', phone: '999', address: 'HQ', password: 'pass123' });
            expect(res.statusCode).toBe(201);
            expect(res.body.message).toBe('Employee created.');
        });

        it('PUT /api/manager/employees/:id - should return 404 if employee not found', async () => {
            mockAsRole('manager');
            mockSql.mockResolvedValueOnce([]); // employee lookup
            const res = await request(app).put('/api/manager/employees/99')
                .send({ userId: 1, firstName: 'New' });
            expect(res.statusCode).toBe(404);
        });

        it('PUT /api/manager/employees/:id - should update employee successfully', async () => {
            mockAsRole('manager');
            mockSql
                .mockResolvedValueOnce([{ id: 2 }]) // found
                .mockResolvedValueOnce([]); // update
            const res = await request(app).put('/api/manager/employees/2')
                .send({ userId: 1, firstName: 'Updated' });
            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Employee updated.');
        });

        it('DELETE /api/manager/employees/:id - should return 404 if not found', async () => {
            mockAsRole('manager');
            mockSql.mockResolvedValueOnce([]); // delete returns nothing
            const res = await request(app).delete('/api/manager/employees/99').send({ userId: 1 });
            expect(res.statusCode).toBe(404);
        });

        it('DELETE /api/manager/employees/:id - should delete employee', async () => {
            mockAsRole('manager');
            mockSql.mockResolvedValueOnce([{ id: 2 }]); // delete succeeds
            const res = await request(app).delete('/api/manager/employees/2').send({ userId: 1 });
            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Employee removed.');
        });

        it('GET /api/manager/summary - should return daily summary', async () => {
            mockAsRole('manager');
            mockSql
                .mockResolvedValueOnce([{ count: '5' }])
                .mockResolvedValueOnce([{ total: '500' }])
                .mockResolvedValueOnce([{ total: '100' }])
                .mockResolvedValueOnce([{ count: '30' }]);
            const res = await request(app).get('/api/manager/summary?userId=1&date=2026-10-10');
            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveProperty('totalIncome');
            expect(res.body).toHaveProperty('netIncome');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // requireRole auth middleware (via employee routes)
    // ─────────────────────────────────────────────────────────────
    describe('Auth Middleware (requireRole)', () => {
        it('should return 401 if userId is not provided', async () => {
            const res = await request(app).get('/api/employee/equipment');
            expect(res.statusCode).toBe(401);
            expect(res.body.error).toBe('Authentication required.');
        });

        it('should return 401 if user is not found in DB', async () => {
            mockSql.mockResolvedValueOnce([]); // user not found
            const res = await request(app).get('/api/employee/equipment?userId=999');
            expect(res.statusCode).toBe(401);
            expect(res.body.error).toBe('User not found.');
        });

        it('should return 403 if user role is insufficient', async () => {
            mockSql.mockResolvedValueOnce([{ role: 'customer' }]); // customer doesn't have access
            const res = await request(app).get('/api/employee/equipment?userId=1');
            expect(res.statusCode).toBe(403);
            expect(res.body.error).toBe('Access denied. Insufficient permissions.');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Bank Transfer Simulation
    // ─────────────────────────────────────────────────────────────
    describe('Bank Transfer Simulation (`POST /api/bank/transfer`)', () => {
        it('should return success for a simulated bank transfer', async () => {
            const res = await request(app).post('/api/bank/transfer').send({});
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.transactionId).toMatch(/^TXN/);
        }, 10000); // allow extra time for the 1.5s simulated delay
    });

});
