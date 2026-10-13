const files = [
  'src/models/Table.js',
  'src/controllers/order.controller.js',
  'src/routes/order.routes.js',
  'src/controllers/admin.table.controller.js',
];

console.log('=== Backend Syntax Check ===');
for (const f of files) {
  try {
    require('./' + f);
    console.log('OK: ' + f);
  } catch (e) {
    console.log('FAIL: ' + f + ' - ' + e.message);
  }
}
