const { pool } = require('../config/database');
const { permissionsFor } = require('../utils/permissions');

const COLS = `id, email, password_hash AS passwordHash, full_name AS fullName, phone, role, is_active AS isActive, last_login_at AS lastLoginAt, created_at AS createdAt, token_version AS tokenVersion`;

const toUser = (row) => (row ? { ...row, isActive: !!row.isActive } : null);

async function findByEmail(email) {
  const [[row]] = await pool.query(`SELECT ${COLS} FROM users WHERE email = ?`, [email.toLowerCase()]);
  return toUser(row);
}

async function findById(id) {
  const [[row]] = await pool.query(`SELECT ${COLS} FROM users WHERE id = ?`, [id]);
  return toUser(row);
}

async function create({ email, passwordHash, fullName, phone, role }, conn = pool) {
  const [res] = await conn.query(
    'INSERT INTO users (email, password_hash, full_name, phone, role) VALUES (?, ?, ?, ?, ?)',
    [email.toLowerCase(), passwordHash, fullName, phone || null, role || 'pharmacy_owner']
  );
  return res.insertId;
}

const touchLogin = (id) => pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [id]);

const publicUser = ({ passwordHash, tokenVersion, ...rest }) => ({ ...rest, permissions: permissionsFor(rest.role) });

async function updateProfile(id, { fullName, email, phone }) {
  await pool.query('UPDATE users SET full_name = ?, email = ?, phone = ? WHERE id = ?', [fullName, email.toLowerCase(), phone || null, id]);
}

/** Also bumps token_version, which signs out every older session */
const setPassword = (id, hash) => pool.query('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [hash, id]);

async function listStaff() {
  const [rows] = await pool.query(`SELECT ${COLS} FROM users WHERE role IN ('admin','manager','staff') ORDER BY FIELD(role, 'admin','manager','staff'), full_name`);
  return rows.map(toUser);
}

async function updateStaff(id, { fullName, role, isActive }) {
  const sets = []; const params = [];
  if (fullName !== undefined) { sets.push('full_name = ?'); params.push(fullName); }
  if (role !== undefined) { sets.push('role = ?'); params.push(role); }
  if (isActive !== undefined) { sets.push('is_active = ?'); params.push(isActive ? 1 : 0); }
  if (sets.length) await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

async function countActiveAdmins() {
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1");
  return n;
}

module.exports = { findByEmail, findById, create, touchLogin, publicUser, updateProfile, setPassword, listStaff, updateStaff, countActiveAdmins };
