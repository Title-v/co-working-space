const { randomBytes, createHash } = require('node:crypto');

const COOKIE = 'spacehub_session';
const WEEK = 7 * 24 * 60 * 60 * 1000;

function tokenHash(req) {
  const match = (req.get('cookie') || '').match(
    /(?:^|;\s*)spacehub_session=([a-f0-9]{64})(?:;|$)/
  );
  return match && createHash('sha256').update(match[1]).digest('hex');
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || process.env.NODE_ENV === 'production',
    path: '/'
  };
}

async function signIn(sql, req, res, userId) {
  const token = randomBytes(32).toString('hex');
  const digest = createHash('sha256').update(token).digest('hex');
  await sql`DELETE FROM web_sessions WHERE expires_at <= now() OR token_hash = ${tokenHash(req)}`;
  await sql`INSERT INTO web_sessions (token_hash, user_id, expires_at)
    VALUES (${digest}, ${userId}, now() + interval '7 days')`;
  res.cookie(COOKIE, token, { ...cookieOptions(req), maxAge: WEEK });
}

async function signOut(sql, req, res) {
  const digest = tokenHash(req);
  if (digest) await sql`DELETE FROM web_sessions WHERE token_hash = ${digest}`;
  res.clearCookie(COOKIE, cookieOptions(req)).sendStatus(204);
}

async function sessionUser(sql, req) {
  const digest = tokenHash(req);
  if (!digest) return null;
  const [user] =
    await sql`SELECT u.id, u.role, u.first_name, u.last_name, u.email, u.phone, u.address
    FROM web_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=${digest} AND s.expires_at>now()`;
  return user || null;
}

function authenticated(getSql, ...roles) {
  return async (req, res, next) => {
    try {
      const user = await sessionUser(getSql(), req);
      if (!user)
        return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อนดำเนินการ' });
      if (roles.length && !roles.includes(user.role)) {
        return res.status(403).json({ error: 'ไม่มีสิทธิ์ใช้ส่วนนี้' });
      }
      req.user = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { authenticated, sessionUser, signIn, signOut };
