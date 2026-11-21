const { pool } = require('../config/database');
const ApiError = require('../utils/ApiError');

const SELECT = `
  p.id, p.owner_user_id AS ownerUserId, p.name, p.store_type AS storeType, p.tin,
  p.street_address AS streetAddress, p.city, p.postal_code AS postalCode,
  p.contact_name AS contactName, p.contact_email AS contactEmail, p.contact_phone AS contactPhone,
  p.license_type AS licenseType, p.license_number AS licenseNumber, p.license_expiry AS licenseExpiry,
  DATEDIFF(p.license_expiry, CURDATE()) AS licenseDaysLeft,
  (p.license_document_path IS NOT NULL) AS hasDocument,
  p.current_balance AS currentBalance,
  p.status, p.rejection_reason AS rejectionReason, p.verified_at AS verifiedAt, p.created_at AS createdAt`;

const shape = (r) => r && { ...r, hasDocument: !!r.hasDocument };

async function list({ q, status, limit, offset }) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(p.name LIKE ? OR p.tin LIKE ? OR p.license_number LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status) { where.push('p.status = ?'); params.push(status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM pharmacies p ${clause}`, params);
  const [rows] = await pool.query(
    `SELECT ${SELECT} FROM pharmacies p ${clause} ORDER BY (p.status = 'pending') DESC, p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [[counts]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(status = 'pending') AS pending FROM pharmacies`
  );
  return { rows: rows.map(shape), total, summary: { accounts: counts.total, pending: Number(counts.pending || 0) } };
}

async function findById(id) {
  const [[row]] = await pool.query(`SELECT ${SELECT} FROM pharmacies p WHERE p.id = ?`, [id]);
  return shape(row);
}

const findByOwner = async (userId) => {
  const [[row]] = await pool.query(`SELECT ${SELECT} FROM pharmacies p WHERE p.owner_user_id = ?`, [userId]);
  return shape(row);
};

async function create(d, conn = pool) {
  const [res] = await conn.query(
    `INSERT INTO pharmacies
      (
       owner_user_id, name, store_type, tin, street_address, city,
       postal_code, contact_name, contact_email, contact_phone, license_type, license_number,
       license_expiry, license_document_path, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.ownerUserId || null, 
     d.name,
     d.storeType, 
     d.tin, 
     d.streetAddress, 
     d.city, 
     d.postalCode, 
     d.contactName, 
     d.contactEmail,
     d.contactPhone, 
     d.licenseType || 'LTO', 
     d.licenseNumber, 
     d.licenseExpiry, 
     d.documentPath || null, 
     'pending']
  );
  return res.insertId;
}

const FIELD_MAP = {
  name: 'name', storeType: 'store_type', tin: 'tin', streetAddress: 'street_address', city: 'city', postalCode: 'postal_code',
  contactName: 'contact_name', contactEmail: 'contact_email', contactPhone: 'contact_phone', licenseType: 'license_type',
  licenseNumber: 'license_number', licenseExpiry: 'license_expiry',
};

/** Partial update – only whitelisted columns are touched */
async function update(id, data) {
  const sets = [];
  const params = [];
  Object.entries(FIELD_MAP).forEach(([key, col]) => {
    if (data[key] !== undefined) { sets.push(`${col} = ?`); params.push(data[key]); }
  });
  if (!sets.length) throw new ApiError(422, 'Nothing to update');
  await pool.query(`UPDATE pharmacies SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

async function setStatus(id, status, { adminId, reason } = {}) {
  await pool.query(
    `UPDATE pharmacies SET status = ?, rejection_reason = ?,
       verified_by = IF(? = 'active', ?, verified_by), verified_at = IF(? = 'active', NOW(), verified_at)
     WHERE id = ?`,
    [status, status === 'rejected' ? reason || null : null, status, adminId || null, status, id]
  );
}

const setDocument = (id, path) => pool.query('UPDATE pharmacies SET license_document_path = ? WHERE id = ?', [path, id]);

async function getDocumentPath(id) {
  const [[row]] = await pool.query('SELECT license_document_path AS p FROM pharmacies WHERE id = ?', [id]);
  return row?.p || null;
}

module.exports = { list, findById, findByOwner, create, update, setStatus, setDocument, getDocumentPath };
