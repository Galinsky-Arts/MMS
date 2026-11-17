/** Thin Postgres helpers shared by the application modules. */
export function withDb(pool) {
 return {
  pool,
  query: (sql, params) => pool.query(sql, params),
  one: async (sql, params) => (await pool.query(sql, params)).rows[0] || null,
  all: async (sql, params) => (await pool.query(sql, params)).rows,
  async tx(fn) {
   const client = await pool.connect();
   try {
    await client.query('BEGIN');
    const scoped = {
     query: (s, p) => client.query(s, p),
     one: async (s, p) => (await client.query(s, p)).rows[0] || null,
     all: async (s, p) => (await client.query(s, p)).rows,
    };
    const out = await fn(scoped);
    await client.query('COMMIT');
    return out;
   } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
   } finally { client.release(); }
  },
 };
}
export async function audit(db, actorId, action, detail = {}) {
 await db.query('INSERT INTO audit_log(actor_user_id, action, detail) VALUES ($1,$2,$3)', [actorId ?? null, action, JSON.stringify(detail)]);
}
export async function notify(db, userId, message) {
 await db.query('INSERT INTO notifications(user_id, message) VALUES ($1,$2)', [userId, message]);
}
