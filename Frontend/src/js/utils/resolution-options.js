/**
 * Smart Cafeteria Ordering System
 * Shared Resolution Reason / Solution option lists for the Manager
 * Resolve workflow (Stock Alerts + Issue Reports) and the kitchen
 * stock-alerts page.
 *
 * Classic (non-module) script - pages include it before the manager /
 * kitchen scripts and read window.ScosResolution. Options are filtered
 * per report type (stock / equipment / other) by the caller.
 */
(function () {
  'use strict';

  var OTHER = 'Other';

  var ALL_REASONS = [
    'Out of Stock',
    'Low Stock',
    'Equipment Failure',
    'Equipment Damage',
    'Expired Items',
    'Supplier Delay',
    'Incorrect Stock Record',
    'Maintenance Required',
    OTHER,
  ];

  var ALL_SOLUTIONS = [
    'Restocked Items',
    'Updated Stock Quantity',
    'Ordered New Supplies',
    'Repaired Equipment',
    'Replaced Equipment',
    'Cleaned and Maintained Equipment',
    'Removed Expired Items',
    'Contacted Supplier',
    'Corrected Inventory Record',
    OTHER,
  ];

  var STOCK_REASONS = [
    'Out of Stock',
    'Low Stock',
    'Expired Items',
    'Supplier Delay',
    'Incorrect Stock Record',
    OTHER,
  ];

  var STOCK_SOLUTIONS = [
    'Restocked Items',
    'Updated Stock Quantity',
    'Ordered New Supplies',
    'Removed Expired Items',
    'Contacted Supplier',
    'Corrected Inventory Record',
    OTHER,
  ];

  var EQUIPMENT_REASONS = [
    'Equipment Failure',
    'Equipment Damage',
    'Maintenance Required',
    OTHER,
  ];

  var EQUIPMENT_SOLUTIONS = [
    'Repaired Equipment',
    'Replaced Equipment',
    'Cleaned and Maintained Equipment',
    'Contacted Supplier',
    OTHER,
  ];

  function uniq(list) {
    var seen = {};
    var out = [];
    list.forEach(function (item) {
      if (!seen[item]) {
        seen[item] = true;
        out.push(item);
      }
    });
    return out;
  }

  // Filtered Reason options for a report type.
  // category: 'stock' | 'equipment' | 'all' (all = stock + equipment + extras).
  function reasonsFor(category) {
    if (category === 'stock') return STOCK_REASONS.slice();
    if (category === 'equipment') return EQUIPMENT_REASONS.slice();
    return uniq(STOCK_REASONS.concat(EQUIPMENT_REASONS, ALL_REASONS));
  }

  // Filtered Solution options for a report type.
  function solutionsFor(category) {
    if (category === 'stock') return STOCK_SOLUTIONS.slice();
    if (category === 'equipment') return EQUIPMENT_SOLUTIONS.slice();
    return uniq(STOCK_SOLUTIONS.concat(EQUIPMENT_SOLUTIONS, ALL_SOLUTIONS));
  }

  // Stock alerts (out_of_stock / low_stock / ingredient_shortage /
  // quality_issue) are all stock-item reports -> stock option lists.
  function categoryForStockAlert(/* alertType */) {
    return 'stock';
  }

  // Issue reports use their category field; unknown/other categories get
  // the full option list.
  function categoryForIssue(category) {
    if (category === 'stock' || category === 'equipment') return category;
    return 'all';
  }

  window.ScosResolution = {
    OTHER: OTHER,
    allReasons: ALL_REASONS.slice(),
    allSolutions: ALL_SOLUTIONS.slice(),
    reasonsFor: reasonsFor,
    solutionsFor: solutionsFor,
    categoryForStockAlert: categoryForStockAlert,
    categoryForIssue: categoryForIssue,
  };
})();
