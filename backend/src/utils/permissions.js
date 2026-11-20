/**
 * Role-based access control. Everything about "who may do what" lives in this one file.
 *   - ROLE_PERMISSIONS: which permissions each staff role has
 *   - RULES: which permission each API route needs (first match wins)
 * To change what a role can do, edit ROLE_PERMISSIONS. No other code needs to change.
 */
const PERMISSION_META = {
  'dashboard.view': 'View the dashboard',
  'customers.view': 'View pharmacy accounts',
  'customers.manage': 'Add, edit, verify, reject and freeze pharmacies',
  'orders.view': 'View orders and invoices',
  'orders.process': 'Approve, ship, deliver and cancel orders',
  'inventory.view': 'View products and batches',
  'inventory.manage': 'Add products and receive batches',
  'payments.record': 'Record invoice payments',
  'users.manage': 'Manage staff accounts and roles',
  'logs.view': 'View activity logs',
};
const ALL = Object.keys(PERMISSION_META);

const ROLE_PERMISSIONS = {
  admin: ALL,
  manager: ALL.filter((p) => !['users.manage', 'logs.view'].includes(p)),
  staff: ['dashboard.view', 'customers.view', 'orders.view', 'orders.process', 'inventory.view', 'inventory.manage'],
};

const ROLE_META = {
  admin: { label: 'Admin', description: 'Full access, including staff accounts and activity logs.' },
  manager: { label: 'Manager', description: 'Runs daily operations: pharmacies, payments, orders and stock.' },
  staff: { label: 'Staff', description: 'Processes orders and manages stock. Pharmacies are read-only.' },
};

const STAFF_ROLES = Object.keys(ROLE_PERMISSIONS);
const permissionsFor = (role) => ROLE_PERMISSIONS[role] || [];
const can = (role, permission) => permissionsFor(role).includes(permission);

const RULES = [
  ['GET', /^\/admin\/dashboard/, 'dashboard.view'],
  ['GET', /^\/admin\/invoices/, 'orders.view'],
  ['POST', /^\/admin\/invoices\/\d+\/payments/, 'payments.record'],
  ['GET', /^\/customers/, 'customers.view'],
  ['*', /^\/customers/, 'customers.manage'],
  ['GET', /^\/products/, 'inventory.view'],
  ['*', /^\/products/, 'inventory.manage'],
  ['GET', /^\/orders/, 'orders.view'],
  ['*', /^\/orders/, 'orders.process'],
];

module.exports = { PERMISSION_META, ROLE_PERMISSIONS, ROLE_META, STAFF_ROLES, RULES, permissionsFor, can };
