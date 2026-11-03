const express = require('express');
const { authenticated } = require('./auth');

const TIME_ZONE = 'Asia/Bangkok';
const clock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});
const times = [
  ['08:00', '10:00'],
  ['10:00', '12:00'],
  ['12:00', '14:00'],
  ['14:00', '16:00'],
  ['16:00', '18:00'],
  ['08:00', '18:00']
];
const slots = times.map(([startTime, endTime]) => ({
  startTime,
  endTime,
  label: startTime + ' – ' + endTime
}));
const holdMinutes = 30;

function bookingWindow(now = new Date()) {
  return {
    today: clock.format(now).slice(0, 10),
    lastDate: clock.format(new Date(+now + 90 * 86400000)).slice(0, 10)
  };
}

function validDay(day, range) {
  if (
    typeof day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    day < range.today ||
    day > range.lastDate
  )
    return false;
  const parsed = new Date(day + 'T00:00:00Z');
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === day;
}

function hasStarted(day, slot) {
  return day + ' ' + slot.startTime <= clock.format(new Date());
}

function deskSchedule(sql, day) {
  return sql`
    SELECT d.id, d.label, COALESCE(d.zone, 'General') AS zone,
      COALESCE(json_agg(json_build_array(to_char(r.start_time,'HH24:MI'), to_char(r.end_time,'HH24:MI')))
        FILTER (WHERE r.desk_id IS NOT NULL), '[]') AS busy
    FROM desks d LEFT JOIN (
      SELECT bd.desk_id, b.start_time, b.end_time FROM booking_desks bd JOIN bookings b ON b.id = bd.booking_id
      WHERE b.booking_date = ${day} AND (b.status IN ('confirmed','checked_in') OR
        (b.status = 'pending' AND (b.expires_at IS NULL OR b.expires_at > now())))
    ) r ON r.desk_id = d.id
    WHERE d.is_active GROUP BY d.id ORDER BY d.id`;
}

function freeDesks(desks, slot) {
  return desks.filter(
    (d) =>
      !d.busy.some(
        ([start, end]) => start < slot.endTime && end > slot.startTime
      )
  );
}

function bookingQuery(sql, userId, id = null) {
  return sql`
    SELECT b.id, to_char(b.booking_date, 'YYYY-MM-DD') AS booking_date,
      to_char(b.start_time,'HH24:MI') AS start_time, to_char(b.end_time,'HH24:MI') AS end_time,
      b.num_desks, b.expires_at, b.payment_id, b.total_baht,
      CASE WHEN b.status='pending' AND b.expires_at<=now() THEN 'expired' ELSE b.status END AS status,
      b.booking_date > (now() AT TIME ZONE 'Asia/Bangkok')::date AS before_booking_day,
      COALESCE((SELECT json_agg(json_build_object('id',d.id,'label',d.label,'zone',d.zone) ORDER BY d.id)
        FROM booking_desks bd JOIN desks d ON d.id=bd.desk_id WHERE bd.booking_id=b.id), '[]') AS desks
    FROM bookings b WHERE b.user_id=${userId} AND (${id}::integer IS NULL OR b.id=${id}::integer)
    ORDER BY b.booking_date DESC, b.start_time DESC, b.id DESC`;
}

const fail = (status, error) => ({ status, body: { error } });
const ok = (body, status = 200) => ({ status, body });
const send = (res, result) => res.status(result.status).json(result.body);

function bookingRoutes(getSql, price) {
  const router = express.Router();
  const customer = authenticated(getSql, 'customer');

  router.get('/settings', (req, res) =>
    res.json({
      ...bookingWindow(),
      timezone: TIME_ZONE,
      price,
      slots,
      holdMinutes,
      paymentMode: 'demo'
    })
  );
  router.get('/availability', async (req, res, next) => {
    const { date } = req.query;
    if (!validDay(date, bookingWindow()))
      return send(res, fail(400, 'กรุณาเลือกวันที่ภายใน 90 วันนับจากวันนี้'));
    try {
      const desks = await deskSchedule(getSql(), date);
      res.json({
        date,
        price,
        desks: desks.map(({ id, label, zone }) => ({ id, label, zone })),
        slots: slots.map((slot) => {
          const started = hasStarted(date, slot);
          const availableIds = started
            ? []
            : freeDesks(desks, slot).map((d) => d.id);
          return {
            ...slot,
            started,
            totalDesks: desks.length,
            availableDesks: availableIds.length,
            availableIds
          };
        })
      });
    } catch (err) {
      next(err);
    }
  });

  router.use(customer);

  router.post('/', async (req, res, next) => {
    const { date, startTime, endTime, deskIds, requestKey } = req.body || {};
    const slot = slots.find(
      (s) => s.startTime === startTime && s.endTime === endTime
    );
    if (!validDay(date, bookingWindow()) || !slot || hasStarted(date, slot))
      return send(res, fail(400, 'วันหรือช่วงเวลานี้เปิดจองไม่ได้'));
    if (
      !Array.isArray(deskIds) ||
      !deskIds.length ||
      deskIds.length > 50 ||
      !deskIds.every(
        (id) => Number.isSafeInteger(id) && id > 0 && id <= 2147483647
      ) ||
      new Set(deskIds).size !== deskIds.length
    ) {
      return send(res, fail(400, 'กรุณาเลือกหมายเลขโต๊ะว่าง'));
    }
    if (
      typeof requestKey !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        requestKey
      )
    ) {
      return send(res, fail(400, 'กรุณาเริ่มรายการจองใหม่'));
    }
    try {
      const result = await getSql().begin(async (tx) => {
        // Every allocator for this day takes the same lock before reading availability.
        await tx`SELECT pg_advisory_xact_lock(hashtext('spacehub.desks'), ${date}::date - DATE '2000-01-01')`;
        const [prior] =
          await tx`SELECT id FROM bookings WHERE user_id=${req.user.id} AND request_key=${requestKey}`;
        if (prior) {
          const [booking] = await bookingQuery(tx, req.user.id, prior.id);
          if (
            booking.booking_date !== date ||
            booking.start_time !== startTime ||
            booking.end_time !== endTime ||
            booking.desks.length !== deskIds.length ||
            !booking.desks.every((d) => deskIds.includes(d.id))
          ) {
            return fail(409, 'รายการเดิมใช้ตัวเลือกอื่น กรุณาเริ่มรายการใหม่');
          }
          return ok({ booking });
        }
        if (hasStarted(date, slot))
          return fail(409, 'ช่วงเวลานี้เริ่มแล้ว กรุณาเลือกเวลาใหม่');
        const available = new Set(
          freeDesks(await deskSchedule(tx, date), slot).map((d) => d.id)
        );
        if (!deskIds.every((id) => available.has(id)))
          return fail(
            409,
            'มีผู้จองโต๊ะที่เลือกไปแล้ว กรุณาเลือกโต๊ะว่างอีกครั้ง'
          );
        const [row] =
          await tx`INSERT INTO bookings (user_id, booking_date, start_time, end_time, num_desks, status, expires_at, total_baht, request_key)
          VALUES (${req.user.id}, ${date}, ${startTime}, ${endTime}, ${deskIds.length}, 'pending',
            LEAST(now() + interval '30 minutes', (${date}::date + ${startTime}::time) AT TIME ZONE 'Asia/Bangkok'), ${price * deskIds.length}, ${requestKey})
          RETURNING id`;
        await tx`INSERT INTO booking_desks (booking_id, desk_id)
          SELECT ${row.id}, unnest(${deskIds}::integer[])`;
        const [booking] = await bookingQuery(tx, req.user.id, row.id);
        return ok({ booking }, 201);
      });
      send(res, result);
    } catch (err) {
      if (err.code === '23505')
        return send(
          res,
          fail(409, 'รายการนี้ถูกบันทึกแล้ว กรุณาตรวจการจองของฉัน')
        );
      next(err);
    }
  });

  router.get('/user/:userId', async (req, res, next) => {
    if (Number(req.params.userId) !== req.user.id)
      return send(res, fail(403, 'ดูได้เฉพาะการจองของตัวเอง'));
    try {
      res.json({ bookings: await bookingQuery(getSql(), req.user.id) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      res.json({ bookings: await bookingQuery(getSql(), req.user.id) });
    } catch (err) {
      next(err);
    }
  });

  router.param('id', (req, res, next, value) => {
    if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647)
      return send(res, fail(404, 'ไม่พบการจองนี้'));
    next();
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const [booking] = await bookingQuery(
        getSql(),
        req.user.id,
        req.params.id
      );
      if (!booking) return send(res, fail(404, 'ไม่พบการจองนี้'));
      res.json({ booking });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/pay', async (req, res, next) => {
    if (req.body?.paymentMethod !== 'demo')
      return send(res, fail(400, 'ระบบนี้รองรับเฉพาะการชำระเงินเดโม'));
    try {
      const result = await getSql().begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('spacehub.desks'), booking_date - DATE '2000-01-01')
          FROM bookings WHERE id=${req.params.id} AND user_id=${req.user.id}`;
        const [b] =
          await tx`SELECT id, status, payment_id, COALESCE(total_baht, num_desks * ${price}::integer) AS amount,
          (expires_at <= clock_timestamp() OR (booking_date + start_time) AT TIME ZONE 'Asia/Bangkok' <= clock_timestamp()) AS expired
          FROM bookings WHERE id=${req.params.id} AND user_id=${req.user.id} FOR UPDATE`;
        if (!b) return fail(404, 'ไม่พบการจองนี้');
        if (b.status === 'confirmed' && b.payment_id)
          return ok({
            status: 'confirmed',
            paymentId: b.payment_id,
            paymentMode: 'demo'
          });
        if (b.status !== 'pending')
          return fail(409, 'รายการนี้ไม่อยู่ระหว่างรอชำระ');
        if (b.expired) {
          await tx`UPDATE bookings SET status='expired' WHERE id=${b.id}`;
          return fail(409, 'หมดเวลากันโต๊ะ กรุณาเลือกโต๊ะใหม่');
        }
        const [payment] =
          await tx`INSERT INTO payments (user_id, booking_id, amount, payment_type, payment_method)
          VALUES (${req.user.id}, ${b.id}, ${b.amount}, 'booking', 'demo') RETURNING id`;
        await tx`UPDATE bookings SET status='confirmed', payment_id=${payment.id}, expires_at=NULL WHERE id=${b.id}`;
        return ok({
          status: 'confirmed',
          paymentId: payment.id,
          paymentMode: 'demo'
        });
      });
      send(res, result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/cancel', async (req, res, next) => {
    try {
      const result = await getSql().begin(async (tx) => {
        const [b] =
          await tx`SELECT id, status, expires_at <= clock_timestamp() AS expired,
          booking_date > (now() AT TIME ZONE 'Asia/Bangkok')::date AS before_day
          FROM bookings WHERE id=${req.params.id} AND user_id=${req.user.id} FOR UPDATE`;
        if (!b) return fail(404, 'ไม่พบการจองนี้');
        if (b.status === 'cancelled') return ok({ status: 'cancelled' });
        if (b.status === 'pending' && b.expired)
          return fail(409, 'รายการนี้หมดเวลาแล้ว');
        if (
          b.status !== 'pending' &&
          !(b.status === 'confirmed' && b.before_day)
        ) {
          return fail(409, 'การจองที่ยืนยันแล้ว ยกเลิกได้ถึงวันก่อนเข้าใช้');
        }
        await tx`UPDATE bookings SET status='cancelled', expires_at=NULL WHERE id=${b.id}`;
        return ok({ status: 'cancelled' });
      });
      send(res, result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { bookingRoutes, slots, bookingWindow };
