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
const { bookingWindow } = require('./lib/bookings');
const signed = () => request.agent(app).set('Cookie', 'spacehub_session=' + 'a'.repeat(64));
mockSql.begin = fn => fn(mockSql);


// Helper: mock auth middleware to pass as a given role
const mockAsRole = (role) => {
    mockSql.mockResolvedValueOnce([{ id: 1, role }]); // requireRole user lookup
};

describe('server.js API Routes - Core Business Logic Testing', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        mockSql.mockReset();
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
            expect(res.body.error).toBeTruthy();
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
            expect(res.body.message).toBeTruthy();
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
            expect(res.body.error).toBeTruthy();
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
            expect(res.body.error).toBeTruthy();
        });

        it('should reject login if the email does not exist', async () => {
            mockSql.mockResolvedValueOnce([]);

            const res = await request(app)
                .post('/api/login')
                .send({ email: 'nobody@example.com', password: 'pass123' });

            expect(res.statusCode).toBe(401);
            expect(res.body.error).toBeTruthy();
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
            expect(res.body.error).toBeTruthy();
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
            expect(res.headers['set-cookie'][0]).toContain('HttpOnly');
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
    describe('Reservation rules', () => {
        const future = bookingWindow(new Date(Date.now() + 86400000)).today;

        it('rolls over at midnight in Bangkok', () => {
            expect(bookingWindow(new Date('2026-11-03T17:00:00Z')).today).toBe('2026-11-04');
        });

        it('counts actual desks and excludes overlapping reservations from full-day availability', async () => {
            mockSql.mockResolvedValueOnce([
                {id:1,zone:'ห้องแสงเช้า',label:'Desk 1',busy:[['08:00','10:00']]},
                {id:2,zone:'ห้องแสงเช้า',label:'Desk 2',busy:[]}
            ]);
            const {status,body} = await request(app).get('/api/bookings/availability').query({date:future});
            expect(status).toBe(200);
            expect(body.slots[0].availableIds).toEqual([2]);
            expect(body.slots[1].availableIds).toEqual([1,2]);
            expect(body.slots.at(-1).availableIds).toEqual([2]);
        });

        it.each(['2000-01-01','2099-01-01','2027-02-31','invalid'])('rejects unavailable dates %s', async date => {
            expect((await request(app).get('/api/bookings/availability').query({date})).status).toBe(400);
        });

        it('rejects duplicate desk ids without creating a hold', async () => {
            mockAsRole('customer');
            const res=await signed().post('/api/bookings').send({date:future,startTime:'08:00',endTime:'10:00',deskIds:[1,1],requestKey:require('node:crypto').randomUUID()});
            expect(res.status).toBe(400);
            expect(mockSql).toHaveBeenCalledTimes(1);
        });

        it('does not trust a user id or role supplied by the browser', async () => {
            expect((await request(app).get('/api/employee/reservations?userId=1')).status).toBe(401);
            mockAsRole('customer');
            expect((await signed().get('/api/bookings/user/2')).status).toBe(403);
            mockAsRole('customer');
            expect((await signed().get('/api/manager/summary?userId=1')).status).toBe(403);
        });

        it('rejects a non-demo payment method', async () => {
            mockAsRole('customer');
            const res=await signed().post('/api/bookings/1/pay').send({paymentMethod:'credit_card'});
            expect(res.status).toBe(400);
        });

        it('expires a hold before taking a demo payment', async () => {
            mockAsRole('customer');
            mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{id:1,status:'pending',expired:true}]);
            const res=await signed().post('/api/bookings/1/pay').send({paymentMethod:'demo'});
            expect(res.status).toBe(409);
            expect(mockSql.mock.calls.at(-1)[0].join(' ')).toContain("status='expired'");
        });

        it('returns an earlier confirmation on a payment retry', async () => {
            mockAsRole('customer');
            mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{id:1,status:'confirmed',payment_id:7}]);
            const res=await signed().post('/api/bookings/1/pay').send({paymentMethod:'demo'});
            expect(res.status).toBe(200);
            expect(res.body.paymentId).toBe(7);
            expect(mockSql).toHaveBeenCalledTimes(3);
        });

        it('keeps confirmed reservations on the service day', async () => {
            mockAsRole('customer');
            mockSql.mockResolvedValueOnce([{id:1,status:'confirmed',before_day:false}]);
            expect((await signed().post('/api/bookings/1/cancel')).status).toBe(409);
        });
    });

    describe('Employee Routes', () => {
        it('GET /api/employee/reservations - should return 401 without a valid session', async () => {
            const res = await signed().get('/api/employee/reservations?date=2026-10-10');
            expect(res.statusCode).toBe(401);
        });

        it('GET /api/employee/reservations - should return 400 if date is missing', async () => {
            mockAsRole('employee');
            const res = await signed().get('/api/employee/reservations?userId=1');
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('Date is required.');
        });

        it('GET /api/employee/reservations - should return reservations for date', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([
                { id: 1, first_name: 'enc:John', last_name: 'enc:Doe', booking_date: '2026-10-10' }
            ]);
            const res = await signed().get('/api/employee/reservations?date=2026-10-10&userId=1');
            expect(res.statusCode).toBe(200);
            expect(res.body.reservations).toBeDefined();
        });

        it('POST /api/employee/checkin rejects bookings outside the confirmed list for today', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([]);
            expect((await signed().post('/api/employee/checkin').send({bookingId:42})).status).toBe(409);
        });

        it('POST /api/employee/checkin records the signed-in employee', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([{id:42}]);
            expect((await signed().post('/api/employee/checkin').send({bookingId:42,employeeId:99})).status).toBe(200);
            expect(mockSql.mock.calls.at(-1).slice(1)).toEqual([42,1]);
        });

        it('GET /api/employee/equipment - should return equipment list', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([{ id: 1, name: 'Chairs', category: 'furniture' }]);
            const res = await signed().get('/api/employee/equipment?userId=1');
            expect(res.statusCode).toBe(200);
            expect(res.body.equipment).toBeDefined();
        });

        it('POST /api/employee/expenses - should reject if category or amount are missing', async () => {
            mockAsRole('employee');
            const res = await signed().post('/api/employee/expenses')
                .send({ userId: 1, employeeId: 1 });
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('Category and amount are required.');
        });

        it('POST /api/employee/expenses - should record expense successfully', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([{ id: 1, category: 'supplies', amount: 50 }]);
            const res = await signed().post('/api/employee/expenses')
                .send({ userId: 1, employeeId: 1, category: 'supplies', amount: 50 });
            expect(res.statusCode).toBe(201);
            expect(res.body.message).toBe('Expense recorded.');
        });

        it('GET /api/employee/expenses - should return expense list', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([
                { id: 1, first_name: 'enc:Staff', last_name: 'enc:A', category: 'supplies', amount: 50 }
            ]);
            const res = await signed().get('/api/employee/expenses?userId=1&date=2026-10-10');
            expect(res.statusCode).toBe(200);
            expect(res.body.expenses).toBeDefined();
        });

        it('PUT /api/employee/equipment/:id - should return 404 if equipment not found', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([]); // update returns nothing
            const res = await signed().put('/api/employee/equipment/99')
                .send({ userId: 1, totalQuantity: 10 });
            expect(res.statusCode).toBe(404);
        });

        it('PUT /api/employee/equipment/:id - should update equipment successfully', async () => {
            mockAsRole('employee');
            mockSql.mockResolvedValueOnce([{ id: 1, name: 'Chairs', total_quantity: 10 }]);
            const res = await signed().put('/api/employee/equipment/1')
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
            const res = await signed().get('/api/manager/revenue?userId=1');
            expect(res.statusCode).toBe(400);
        });

        it('GET /api/manager/revenue - should return daily revenue', async () => {
            mockAsRole('manager');
            mockSql
                .mockResolvedValueOnce([{ payment_type: 'booking', payment_method: 'credit_card', total: 100, count: 2 }])
                .mockResolvedValueOnce([{ total_revenue: '100', payment_count: '2' }]);
            const res = await signed().get('/api/manager/revenue?userId=1&period=day&date=2026-10-10');
            expect(res.statusCode).toBe(200);
            expect(res.body.period).toBe('day');
        });

        it('GET /api/manager/revenue - should return monthly revenue', async () => {
            mockAsRole('manager');
            mockSql
                .mockResolvedValueOnce([{ payment_type: 'subscription', total: 5000, count: 10 }])
                .mockResolvedValueOnce([{ total_revenue: '5000', payment_count: '10' }]);
            const res = await signed().get('/api/manager/revenue?userId=1&period=month&month=2026-10');
            expect(res.statusCode).toBe(200);
            expect(res.body.period).toBe('month');
        });

        it('GET /api/manager/report - should reject if month is missing', async () => {
            mockAsRole('manager');
            const res = await signed().get('/api/manager/report?userId=1');
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
            const res = await signed().get('/api/manager/report?userId=1&month=2026-10');
            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveProperty('totalRevenue');
            expect(res.body).toHaveProperty('netIncome');
        });

        it('GET /api/manager/employees - should return employee list', async () => {
            mockAsRole('manager');
            mockSql.mockResolvedValueOnce([
                { id: 2, first_name: 'enc:Staff', last_name: 'enc:One', email: 'staff@x.com', phone: 'enc:000', address: 'enc:addr', role: 'employee' }
            ]);
            const res = await signed().get('/api/manager/employees?userId=1');
            expect(res.statusCode).toBe(200);
            expect(res.body.employees).toBeDefined();
        });

        it('POST /api/manager/employees - should reject if fields missing', async () => {
            mockAsRole('manager');
            const res = await signed().post('/api/manager/employees')
                .send({ userId: 1, firstName: 'Staff' });
            expect(res.statusCode).toBe(400);
        });

        it('POST /api/manager/employees - should create employee successfully', async () => {
            mockAsRole('manager');
            mockSql
                .mockResolvedValueOnce([]) // email check
                .mockResolvedValueOnce([{ id: 5, email: 'staff@x.com' }]); // insert
            const res = await signed().post('/api/manager/employees')
                .send({ userId: 1, firstName: 'Staff', lastName: 'One', email: 'staff@x.com', phone: '999', address: 'HQ', password: 'pass123' });
            expect(res.statusCode).toBe(201);
            expect(res.body.message).toBe('Employee created.');
        });

        it('PUT /api/manager/employees/:id - should return 404 if employee not found', async () => {
            mockAsRole('manager');
            mockSql.mockResolvedValueOnce([]); // employee lookup
            const res = await signed().put('/api/manager/employees/99')
                .send({ userId: 1, firstName: 'New' });
            expect(res.statusCode).toBe(404);
        });

        it('PUT /api/manager/employees/:id - should update employee successfully', async () => {
            mockAsRole('manager');
            mockSql
                .mockResolvedValueOnce([{ id: 2 }]) // found
                .mockResolvedValueOnce([]); // update
            const res = await signed().put('/api/manager/employees/2')
                .send({ userId: 1, firstName: 'Updated' });
            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Employee updated.');
        });

        it('DELETE /api/manager/employees/:id - should return 404 if not found', async () => {
            mockAsRole('manager');
            mockSql.mockResolvedValueOnce([]); // delete returns nothing
            const res = await signed().delete('/api/manager/employees/99').send({ userId: 1 });
            expect(res.statusCode).toBe(404);
        });

        it('DELETE /api/manager/employees/:id - should delete employee', async () => {
            mockAsRole('manager');
            mockSql.mockResolvedValueOnce([{ id: 2 }]); // delete succeeds
            const res = await signed().delete('/api/manager/employees/2').send({ userId: 1 });
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
            const res = await signed().get('/api/manager/summary?userId=1&date=2026-10-10');
            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveProperty('totalIncome');
            expect(res.body).toHaveProperty('netIncome');
        });
    });


});
