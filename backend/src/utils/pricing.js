require('dotenv').config();

// Payment term 
const TERMS_DAYS = { COD: 7, BANK: 3, EWALLET: 3 };
const MIN_SHELF_LIFE_DAYS = Number(process.env.MIN_SHELF_LIFE_DAYS || 30);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

module.exports = { TERMS_DAYS, MIN_SHELF_LIFE_DAYS, round2 };
