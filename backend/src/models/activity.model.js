const { pool } = require('../config/database');

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

async function record(e) {
  await pool.query(
    `INSERT INTO activity_logs (user_id, user_name, user_role, action, description, entity_type, entity_id, ip_address, status_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [e.userId || null, clip(e.userName, 150), clip(e.userRole, 30), clip(e.action, 60), clip(e.description, 255), clip(e.entityType, 30), e.entityId || null, clip(e.ip, 64), e.statusCode || null]
  );
}

async function list({ page = 1, limit = 15, q, category, from, to }) {
  const where = [];
  const params = [];
  if (q) { where.push('(description LIKE ? OR user_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (category) { where.push('action LIKE ?'); params.push(`${category}.%`); }
  if (from) { where.push('created_at >= ?'); params.push(`${from} 00:00:00`); }
  if (to) { where.push('created_at <= ?'); params.push(`${to} 23:59:59`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM activity_logs ${w}`, params);
  const [rows] = await pool.query(
    `SELECT id, user_id AS userId, user_name AS userName, user_role AS userRole, action, description,
            entity_type AS entityType, entity_id AS entityId, ip_address AS ip, status_code AS statusCode, created_at AS createdAt
     FROM activity_logs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit]
  );
  return { rows, total };
}

module.exports = { record, list };
