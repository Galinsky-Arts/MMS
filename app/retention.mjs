/** Deletes declined/withdrawn applications (and their encrypted uploads, via cascade) after the
 * configured retention period. Does nothing while retention is not configured. */
export async function purgeExpired(db, settings) {
 const s = await settings.all();
 if (!(Number.isSafeInteger(s.retention_days) && s.retention_days >= 1)) return 0;
 const {rowCount} = await db.query(`DELETE FROM applications WHERE status IN ('declined','withdrawn') AND COALESCE(decided_at, updated_at) < now() - make_interval(days => $1)`, [s.retention_days]);
 await db.query(`DELETE FROM notifications WHERE at < now() - interval '180 days'`);
 await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
 if (rowCount) await db.query('INSERT INTO audit_log(action, detail) VALUES ($1,$2)', ['retention.purged', JSON.stringify({count: rowCount})]);
 return rowCount;
}
