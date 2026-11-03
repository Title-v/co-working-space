const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const postgres = require('postgres');

const base = process.env.BOOKING_TEST_URL;
const connection = process.env.BOOKING_TEST_DATABASE_URL;
if (!base || !connection)
  throw new Error(
    'Set BOOKING_TEST_URL and BOOKING_TEST_DATABASE_URL to a disposable test environment.'
  );
const db = postgres(connection, { max: 1, prepare: false });
const accounts = [randomUUID(), randomUUID()].map((id) => ({
  email: id + '@example.invalid',
  password: randomBytes(16).toString('hex')
}));

async function call(path, cookie, body, expected) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = response.status === 204 ? {} : await response.json();
  if (expected)
    assert.equal(
      response.status,
      expected,
      path + ' ' + JSON.stringify(result)
    );
  return {
    status: response.status,
    result,
    cookie: response.headers.get('set-cookie')?.split(';')[0]
  };
}

async function verify() {
  for (const account of accounts) {
    await call(
      '/api/register',
      null,
      {
        ...account,
        firstName: 'Integration',
        lastName: 'Fixture',
        phone: '0000000000',
        role: 'manager'
      },
      201
    );
    const login = await call('/api/login', null, account, 200);
    account.cookie = login.cookie;
    account.id = login.result.user.id;
    assert.equal(login.result.user.role, 'customer');
  }
  const settings = (await call('/api/bookings/settings', null, undefined, 200))
    .result;
  assert.equal(settings.timezone, 'Asia/Bangkok');
  const future = new Date(settings.today + 'T12:00:00Z');
  future.setUTCDate(future.getUTCDate() + 2);
  const date = future.toISOString().slice(0, 10);
  const available = async () =>
    (
      await call(
        '/api/bookings/availability?date=' + date,
        null,
        undefined,
        200
      )
    ).result;
  const initial = await available();
  const fullDay = initial.slots.at(-1),
    first = initial.slots[0];
  const desk = fullDay.availableIds[0];
  assert.ok(desk);
  const attempts = [fullDay, first].map((slot) => ({
    date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    deskIds: [desk],
    requestKey: randomUUID()
  }));
  const race = await Promise.all(
    attempts.map((draft, i) => call('/api/bookings', accounts[i].cookie, draft))
  );
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
  const won = race.findIndex((r) => r.status === 201),
    lost = 1 - won;
  const booking = race[won].result.booking,
    owner = accounts[won],
    other = accounts[lost];
  const path = '/api/bookings/' + booking.id;
  assert.equal(booking.status, 'pending');
  assert.equal(Number(booking.total_baht), settings.price);
  assert.equal(
    (await call('/api/bookings', owner.cookie, attempts[won], 200)).result
      .booking.id,
    booking.id
  );
  assert.ok(!(await available()).slots[0].availableIds.includes(desk));
  console.log(
    'Overlapping requests -> one hold (201), one conflict (409); retry -> same reservation'
  );

  await call(path, other.cookie, undefined, 404);
  await call(
    path + '/pay',
    other.cookie,
    { userId: owner.id, paymentMethod: 'demo' },
    404
  );
  await call(path + '/cancel', other.cookie, { userId: owner.id }, 404);
  await call('/api/manager/summary?userId=1', other.cookie, undefined, 403);
  await call(path, null, undefined, 401);
  console.log(
    'Anonymous reads, account spoofing, cross-account payment and cancellation rejected'
  );

  const paid = await Promise.all(
    [1, 2].map(() =>
      call(
        path + '/pay',
        owner.cookie,
        { paymentMethod: 'demo', amount: 0 },
        200
      )
    )
  );
  assert.equal(paid[0].result.paymentId, paid[1].result.paymentId);
  const [ledger] =
    await db`SELECT count(*)::int AS entries, sum(amount) AS total FROM payments WHERE booking_id=${booking.id}`;
  assert.equal(ledger.entries, 1);
  assert.equal(Number(ledger.total), settings.price);
  const mine = (await call('/api/bookings', owner.cookie, undefined, 200))
    .result.bookings;
  assert.equal(mine.find((b) => b.id === booking.id).status, 'confirmed');
  console.log(
    'Concurrent demo payments -> one ledger entry at the server price; confirmed in My Bookings'
  );

  await call(path + '/cancel', owner.cookie, {}, 200);
  assert.ok((await available()).slots[0].availableIds.includes(desk));
  const replacement = (
    await call('/api/bookings', other.cookie, attempts[lost], 201)
  ).result.booking;
  await db`UPDATE bookings SET expires_at=now()-interval '1 second' WHERE id=${replacement.id} AND user_id=${other.id}`;
  await call(
    '/api/bookings/' + replacement.id + '/pay',
    other.cookie,
    { paymentMethod: 'demo' },
    409
  );
  assert.ok((await available()).slots[0].availableIds.includes(desk));
  await verifyPrivateRooms(date, available, owner, other);
  await call('/api/logout', owner.cookie, {}, 204);
  await call(path, owner.cookie, undefined, 401);
  console.log(
    'Cancellation and expiry release the desk; logout revokes the session'
  );
}

async function verifyPrivateRooms(date, available, owner, other) {
  const inventory = await available();
  assert.equal(inventory.privateRooms.length, 10);
  assert.deepEqual(
    inventory.privateRooms.map((r) => r.capacity),
    [2, 2, 4, 4, 6, 6, 8, 8, 10, 12]
  );
  const first = inventory.slots[0],
    next = inventory.slots[1],
    fullDay = inventory.slots.at(-1);
  const room = inventory.privateRooms.find((r) =>
    fullDay.availableRoomIds.includes(r.id)
  );
  assert.ok(room);
  const otherRoom = fullDay.availableRoomIds.find((id) => id !== room.id);
  const draft = (slot) => ({
    date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    privateRoomId: room.id,
    requestKey: randomUUID()
  });
  const path = (id) => '/api/bookings/' + id;
  const reserve = (account, selection, expected) =>
    call('/api/bookings', account.cookie, selection, expected);

  // A desk hold and a private room are different inventory, even when their numeric IDs match.
  const deskId = fullDay.availableIds.includes(room.id)
    ? room.id
    : fullDay.availableIds[0];
  assert.ok(deskId);
  const deskDraft = {
    date,
    startTime: fullDay.startTime,
    endTime: fullDay.endTime,
    deskIds: [deskId],
    requestKey: randomUUID()
  };
  const deskBooking = (await reserve(owner, deskDraft, 201)).result.booking;
  assert.ok(
    (await available()).slots.at(-1).availableRoomIds.includes(room.id)
  );
  const attempt = { ...draft(fullDay), total_baht: 1 };
  const race = await Promise.all(
    [owner, other].map((account) => reserve(account, { ...attempt }))
  );
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
  const winner = race[0].status === 201 ? owner : other;
  const loser = winner === owner ? other : owner;
  const roomBooking = race.find((r) => r.status === 201).result.booking;
  assert.deepEqual(roomBooking.private_room, {
    id: room.id,
    name: room.name,
    capacity: room.capacity
  });
  assert.deepEqual(roomBooking.desks, []);
  assert.equal(roomBooking.num_desks, 0);
  assert.equal(Number(roomBooking.total_baht), room.hourlyRate * 10);
  assert.equal(
    (await reserve(winner, attempt, 200)).result.booking.id,
    roomBooking.id
  );
  await reserve(winner, { ...deskDraft, requestKey: attempt.requestKey }, 409);
  const whileHeld = await available();
  assert.ok(
    whileHeld.slots.every(
      (s) =>
        !s.availableRoomIds.includes(room.id) &&
        s.availableRoomIds.includes(otherRoom)
    )
  );
  await reserve(loser, draft(first), 409);
  await call(path(roomBooking.id), loser.cookie, undefined, 404);

  const payments = await Promise.all(
    [1, 2].map(() =>
      call(
        path(roomBooking.id) + '/pay',
        winner.cookie,
        { paymentMethod: 'demo', amount: 0 },
        200
      )
    )
  );
  assert.equal(payments[0].result.paymentId, payments[1].result.paymentId);
  const [ledger] =
    await db`SELECT count(*)::int AS entries,sum(amount) AS total FROM payments WHERE booking_id=${roomBooking.id}`;
  assert.equal(ledger.entries, 1);
  assert.equal(Number(ledger.total), room.hourlyRate * 10);
  const saved = (
    await call('/api/bookings', winner.cookie, undefined, 200)
  ).result.bookings.find((b) => b.id === roomBooking.id);
  assert.equal(saved.status, 'confirmed');
  assert.equal(saved.private_room.capacity, room.capacity);
  await call(path(roomBooking.id) + '/cancel', winner.cookie, {}, 200);

  const brief = (await reserve(loser, draft(first), 201)).result.booking;
  assert.equal(Number(brief.total_baht), room.hourlyRate * 2);
  const after = await available();
  assert.ok(!after.slots.at(-1).availableRoomIds.includes(room.id));
  assert.ok(after.slots[1].availableRoomIds.includes(room.id));
  const adjacent = (await reserve(winner, draft(next), 201)).result.booking;
  await call(path(adjacent.id) + '/cancel', winner.cookie, {}, 200);
  await db`UPDATE bookings SET expires_at=now()-interval '1 second' WHERE id=${brief.id} AND user_id=${loser.id}`;
  await call(
    path(brief.id) + '/pay',
    loser.cookie,
    { paymentMethod: 'demo' },
    409
  );
  assert.ok(
    (await available()).slots.at(-1).availableRoomIds.includes(room.id)
  );
  await call(path(deskBooking.id) + '/cancel', owner.cookie, {}, 200);
  console.log(
    '10 whole rooms: capacities, independent desks, exclusive holds, full-day/adjacent slots, pricing, idempotent payment, cancellation and expiry passed'
  );
}

async function cleanup() {
  await db.begin(async (tx) => {
    for (const account of accounts) {
      const [user] =
        await tx`SELECT id FROM users WHERE email=${account.email} AND role='customer'`;
      if (!user) continue;
      await tx`DELETE FROM bookings WHERE user_id=${user.id}`;
      await tx`DELETE FROM payments WHERE user_id=${user.id}`;
      await tx`DELETE FROM users WHERE id=${user.id} AND email=${account.email}`;
    }
  });
}

(async () => {
  try {
    await verify();
  } finally {
    try {
      await cleanup();
    } finally {
      await db.end();
    }
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
