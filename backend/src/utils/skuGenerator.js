const { pool } = require('../config/database');

/**
 * AMX-500-0001: first 3 letters of the name, strength digits, next product number.
*/
async function generateSku({ name = '', strength = '' }) {
  const prefix = (name.replace(/[^a-zA-Z]/g, ' ').trim().split(/\s+/)[0] || 'PRD').slice(0, 3).toUpperCase().padEnd(3, 'X');
  const dose = ((String(strength).match(/\d+/) || ['0'])[0]).padStart(3, '0').slice(0, 3);
  const [[{ next }]] = await pool.query('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM products');
  return `${prefix}-${dose}-${String(next).padStart(4, '0')}`;
}

module.exports = { generateSku };
