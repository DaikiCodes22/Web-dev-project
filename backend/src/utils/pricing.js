require('dotenv').config();

// Payment term 
const TERMS_DAYS = { COD: 7, BANK: 3, EWALLET: 3 };
// The payment methods a pharmacy can choose from on each order
const PAYMENT_METHODS = Object.keys(TERMS_DAYS);
const MIN_SHELF_LIFE_DAYS = Number(process.env.MIN_SHELF_LIFE_DAYS || 30);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

module.exports = { PAYMENT_METHODS, TERMS_DAYS, MIN_SHELF_LIFE_DAYS, round2 };
