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
function timeSlot(startTime, endTime) {
  return {
    startTime,
    endTime,
    durationHours: Number(endTime.slice(0, 2)) - Number(startTime.slice(0, 2)),
    label: startTime + ' – ' + endTime
  };
}

const slots = times.map(([startTime, endTime]) => timeSlot(startTime, endTime));
const roomSlots = [];
for (let startHour = 8; startHour < 18; startHour++) {
  for (let endHour = startHour + 1; endHour <= 18; endHour++) {
    roomSlots.push(
      timeSlot(
        String(startHour).padStart(2, '0') + ':00',
        String(endHour).padStart(2, '0') + ':00'
      )
    );
  }
}
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

function hasStarted(day, slot, now = clock.format(new Date())) {
  return day + ' ' + slot.startTime <= now;
}

// Desks and private rooms are separate inventories. Only the same resource and
// overlapping time can block a new booking; both use the same hold expiry rule.
function spaceSchedule(sql, day) {
  return sql`
    WITH inventory (kind, id, label, zone, capacity, hourly_rate) AS (
      SELECT 'desk'::text, id, label, COALESCE(zone, 'General'), NULL::integer, NULL::integer
        FROM desks WHERE is_active
      UNION ALL
      SELECT 'room', id, name, NULL, capacity, hourly_rate FROM private_rooms WHERE is_active
    ), occupied AS (
      SELECT CASE WHEN b.private_room_id IS NULL THEN 'desk' ELSE 'room' END AS kind,
        COALESCE(b.private_room_id, bd.desk_id) AS id, b.start_time, b.end_time
      FROM bookings b LEFT JOIN booking_desks bd ON bd.booking_id=b.id
      WHERE b.booking_date=${day} AND (b.status IN ('confirmed','checked_in') OR
        (b.status='pending' AND (b.expires_at IS NULL OR b.expires_at > statement_timestamp())))
    )
    SELECT i.kind, i.id, i.label, i.zone, i.capacity, i.hourly_rate,
      COALESCE(json_agg(json_build_array(to_char(o.start_time,'HH24:MI'), to_char(o.end_time,'HH24:MI')))
        FILTER (WHERE o.id IS NOT NULL), '[]') AS busy
    FROM inventory i LEFT JOIN occupied o ON o.kind=i.kind AND o.id=i.id
    GROUP BY i.kind,i.id,i.label,i.zone,i.capacity,i.hourly_rate
    ORDER BY i.kind,i.id`;
}

function availableSpaces(spaces, slot) {
  return spaces.filter(
    (space) =>
      !space.busy.some(
        ([start, end]) => start < slot.endTime && end > slot.startTime
      )
  );
}

function validId(id) {
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647;
}

function bookingQuery(sql, userId, id = null) {
  return sql`
    SELECT b.id, to_char(b.booking_date, 'YYYY-MM-DD') AS booking_date,
      to_char(b.start_time,'HH24:MI') AS start_time, to_char(b.end_time,'HH24:MI') AS end_time,
      b.num_desks, b.expires_at, b.payment_id, b.total_baht,
      CASE WHEN r.id IS NOT NULL THEN json_build_object('id', r.id, 'name', r.name, 'capacity', r.capacity) END AS private_room,
      CASE WHEN b.status='pending' AND b.expires_at<=now() THEN 'expired' ELSE b.status END AS status,
      b.booking_date > (now() AT TIME ZONE 'Asia/Bangkok')::date AS before_booking_day,
      COALESCE((SELECT json_agg(json_build_object('id',d.id,'label',d.label,'zone',d.zone) ORDER BY d.id)
        FROM booking_desks bd JOIN desks d ON d.id=bd.desk_id WHERE bd.booking_id=b.id), '[]') AS desks
    FROM bookings b LEFT JOIN private_rooms r ON r.id=b.private_room_id WHERE b.user_id=${userId} AND (${id}::integer IS NULL OR b.id=${id}::integer)
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
      roomSlots,
      holdMinutes,
      paymentMode: 'demo'
    })
  );
  router.get('/availability', async (req, res, next) => {
    const { date } = req.query;
    if (!validDay(date, bookingWindow()))
      return send(res, fail(400, 'กรุณาเลือกวันที่ภายใน 90 วันนับจากวันนี้'));
    try {
      const inventory = await spaceSchedule(getSql(), date);
      const desks = inventory.filter((space) => space.kind === 'desk');
      const rooms = inventory.filter((space) => space.kind === 'room');
      const now = clock.format(new Date());
      res.json({
        date,
        price,
        desks: desks.map(({ id, label, zone }) => ({ id, label, zone })),
        privateRooms: rooms.map(({ id, label, capacity, hourly_rate }) => ({
          id,
          name: label,
          capacity,
          hourlyRate: hourly_rate
        })),
        roomSlots: roomSlots.map((slot) => {
          const started = hasStarted(date, slot, now);
          return {
            ...slot,
            started,
            availableRoomIds: started
              ? []
              : availableSpaces(rooms, slot).map((room) => room.id)
          };
        }),
        slots: slots.map((slot) => {
          const started = hasStarted(date, slot, now);
          const availableIds = started
            ? []
            : availableSpaces(desks, slot).map((d) => d.id);
          return {
            ...slot,
            started,
            totalDesks: desks.length,
            availableDesks: availableIds.length,
            availableIds,
            availableRoomIds: started
              ? []
              : availableSpaces(rooms, slot).map((room) => room.id)
          };
        })
      });
    } catch (err) {
      next(err);
    }
  });

  router.use(customer);

  router.post('/', async (req, res, next) => {
    const { date, startTime, endTime, deskIds, privateRoomId, requestKey } =
      req.body || {};
    const isRoom = privateRoomId !== undefined;
    const bookableSlots = isRoom ? roomSlots : slots;
    const slot = bookableSlots.find(
      (s) => s.startTime === startTime && s.endTime === endTime
    );
    if (!validDay(date, bookingWindow()) || !slot || hasStarted(date, slot))
      return send(res, fail(400, 'วันหรือช่วงเวลานี้เปิดจองไม่ได้'));
    if (isRoom && (!validId(privateRoomId) || deskIds !== undefined)) {
      return send(res, fail(400, 'กรุณาเลือกห้องส่วนตัวหนึ่งห้องต่อรายการ'));
    }
    if (
      !isRoom &&
      (!Array.isArray(deskIds) ||
        !deskIds.length ||
        deskIds.length > 50 ||
        !deskIds.every(validId) ||
        new Set(deskIds).size !== deskIds.length)
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
          const sameSelection = isRoom
            ? booking.private_room?.id === privateRoomId
            : !booking.private_room &&
              booking.desks.length === deskIds.length &&
              booking.desks.every((d) => deskIds.includes(d.id));
          if (
            booking.booking_date !== date ||
            booking.start_time !== startTime ||
            booking.end_time !== endTime ||
            !sameSelection
          ) {
            return fail(409, 'รายการเดิมใช้ตัวเลือกอื่น กรุณาเริ่มรายการใหม่');
          }
          return ok({ booking });
        }
        if (hasStarted(date, slot))
          return fail(409, 'ช่วงเวลานี้เริ่มแล้ว กรุณาเลือกเวลาใหม่');
        const free = availableSpaces(await spaceSchedule(tx, date), slot);
        let total;
        if (isRoom) {
          const room = free.find(
            (space) => space.kind === 'room' && space.id === privateRoomId
          );
          if (!room)
            return fail(
              409,
              'ห้องส่วนตัวนี้ไม่ว่างในรอบที่เลือก กรุณาเลือกห้องหรือเวลาใหม่'
            );
          total = room.hourly_rate * slot.durationHours;
        } else {
          const availableIds = new Set(
            free.filter((space) => space.kind === 'desk').map((d) => d.id)
          );
          if (!deskIds.every((id) => availableIds.has(id)))
            return fail(
              409,
              'มีผู้จองโต๊ะที่เลือกไปแล้ว กรุณาเลือกโต๊ะว่างอีกครั้ง'
            );
          total = price * deskIds.length;
        }
        const [row] =
          await tx`INSERT INTO bookings (user_id, booking_date, start_time, end_time, num_desks, private_room_id, status, expires_at, total_baht, request_key)
          VALUES (${req.user.id}, ${date}, ${startTime}, ${endTime}, ${isRoom ? 0 : deskIds.length}, ${privateRoomId ?? null}, 'pending',
            LEAST(now() + interval '30 minutes', (${date}::date + ${startTime}::time) AT TIME ZONE 'Asia/Bangkok'), ${total}, ${requestKey})
          RETURNING id`;
        if (!isRoom) {
          await tx`INSERT INTO booking_desks (booking_id, desk_id)
            SELECT ${row.id}, unnest(${deskIds}::integer[])`;
        }
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
          return fail(409, 'หมดเวลารอชำระ กรุณาเริ่มการจองใหม่');
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
