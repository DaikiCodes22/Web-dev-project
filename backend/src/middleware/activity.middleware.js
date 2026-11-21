const Activity = require('../models/activity.model');

const clip = (v, n) => String(v ?? '').slice(0, n);
const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH');
const STATUS_WORDS = { batching: 'approved', in_transit: 'in transit', delivered: 'delivered', cancelled: 'cancelled' };

// [method, path pattern, (match, body, responseBody) => { action, text, entity? }]
// Only chosen fields go into the text. Passwords and tokens are never logged.
const RULES = [
  ['POST', /^\/auth\/register$/, () => ({ action: 'auth.register', text: 'Registered a new pharmacy account' })],
  ['POST', /^\/orders$/, (m, b, r) => ({ action: 'order.create', text: `Placed order ${r?.orderNo || ''}`.trim(), entity: ['order', r?.id] })],
  ['PATCH', /^\/orders\/(\d+)\/status$/, (m, b) => ({ action: `order.${b.status}`, text: `Marked order #${m[1]} as ${STATUS_WORDS[b.status] || b.status}`, entity: ['order', m[1]] })],
  ['POST', /^\/customers$/, (m, b) => ({ action: 'customer.create', text: `Added pharmacy "${clip(b.name, 80)}"` })],
  ['PUT', /^\/customers\/(\d+)$/, (m) => ({ action: 'customer.update', text: `Edited pharmacy #${m[1]}`, entity: ['customer', m[1]] })],
  ['PATCH', /^\/customers\/(\d+)\/status$/, (m, b) => ({ action: `customer.${b.action}`, text: `${{ verify: 'Verified', reject: 'Rejected', freeze: 'Froze', unfreeze: 'Unfroze' }[b.action] || b.action} pharmacy #${m[1]}`, entity: ['customer', m[1]] })],
  ['PATCH', /^\/customers\/(\d+)\/terms$/, (m) => ({ action: 'customer.terms', text: `Changed credit or payment method for pharmacy #${m[1]}`, entity: ['customer', m[1]] })],
  ['POST', /^\/customers\/(\d+)\/document$/, (m) => ({ action: 'customer.permit_upload', text: `Uploaded a permit for pharmacy #${m[1]}`, entity: ['customer', m[1]] })],
  ['GET', /^\/customers\/(\d+)\/document$/, (m) => ({ action: 'customer.permit_view', text: `Viewed the permit of pharmacy #${m[1]}`, entity: ['customer', m[1]] })],
  ['POST', /^\/products$/, (m, b) => ({ action: 'product.create', text: `Added product "${clip(b.name, 80)}"` })],
  ['PUT', /^\/products\/(\d+)$/, (m) => ({ action: 'product.update', text: `Edited product #${m[1]}`, entity: ['product', m[1]] })],
  ['POST', /^\/products\/(\d+)\/image$/, (m) => ({ action: 'product.image', text: `Changed the photo of product #${m[1]}`, entity: ['product', m[1]] })],
  ['DELETE', /^\/products\/(\d+)\/image$/, (m) => ({ action: 'product.image', text: `Removed the photo of product #${m[1]}`, entity: ['product', m[1]] })],
  ['DELETE', /^\/products\/(\d+)$/, (m) => ({ action: 'product.delete', text: `Deleted product #${m[1]}`, entity: ['product', m[1]] })],
  ['POST', /^\/products\/(\d+)\/batches$/, (m, b) => ({ action: 'batch.receive', text: `Received batch ${clip(b.batchNumber, 40)} (${Number(b.quantity) || 0} units) for product #${m[1]}`, entity: ['product', m[1]] })],
  ['POST', /^\/admin\/invoices\/(\d+)\/payments$/, (m, b) => ({ action: 'payment.record', text: `Recorded a ${peso(b.amount)} payment on invoice #${m[1]}`, entity: ['invoice', m[1]] })],
  ['POST', /^\/settings\/users$/, (m, b) => ({ action: 'user.create', text: `Created a ${clip(b.role, 20)} account for ${clip(b.email, 80)}` })],
  ['PATCH', /^\/settings\/users\/(\d+)$/, (m, b) => ({ action: 'user.update', text: `Updated user #${m[1]}${b.role ? ` (role: ${clip(b.role, 20)})` : ''}${b.isActive === false ? ' (deactivated)' : b.isActive === true ? ' (activated)' : ''}`, entity: ['user', m[1]] })],
  ['POST', /^\/settings\/users\/(\d+)\/reset-password$/, (m) => ({ action: 'user.reset_password', text: `Reset the password of user #${m[1]}`, entity: ['user', m[1]] })],
  ['PATCH', /^\/settings\/profile$/, () => ({ action: 'profile.update', text: 'Updated their own profile' })],
  ['PUT', /^\/settings\/password$/, () => ({ action: 'profile.password', text: 'Changed their own password' })],
];

function describe(req, res) {
  const path = req.originalUrl.split('?')[0].replace(/^\/api/, '');
  const status = res.statusCode;
  const responseBody = res.locals.body;
  if (req.method === 'POST' && path === '/auth/login') {
    if (status === 200) return { user: responseBody?.user, action: 'auth.login', text: 'Signed in' };
    if (status === 401) return { action: 'auth.login_failed', text: `Failed sign-in attempt for ${clip(req.body?.email, 80)}` };
    return null;
  }
  if (status >= 400) return null;
  const hit = RULES.find(([method, re]) => method === req.method && re.test(path));
  if (hit) return { ...hit[2](path.match(hit[1]), req.body || {}, responseBody), user: path.startsWith('/auth') ? responseBody?.user : undefined };
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return null;
  return { action: req.method.toLowerCase(), text: `${req.method} ${path}` };
}

/** Records who did what for every successful change (plus sign-ins and failed sign-ins). */
function activityLogger(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => { res.locals.body = body; return json(body); };
  res.on('finish', () => {
    try {
      const entry = describe(req, res);
      if (!entry) return;
      const actor = entry.user || (req.user && { id: req.user.id, fullName: req.user.fullName, role: req.user.role });
      Activity.record({
        userId: actor?.id, userName: actor?.fullName, userRole: actor?.role, action: entry.action, description: entry.text,
        entityType: entry.entity?.[0], entityId: entry.entity?.[1], ip: req.ip, statusCode: res.statusCode,
      }).catch((e) => console.error('activity log failed:', e.message));
    } catch (e) { console.error('activity log failed:', e.message); }
  });
  next();
}

module.exports = activityLogger;
