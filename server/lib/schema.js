export const schemaSql = `
CREATE TABLE IF NOT EXISTS leased_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_code TEXT,
  group_name TEXT,
  node_code TEXT,
  node_name TEXT,
  region_name TEXT,
  group_product_code TEXT,
  group_user_name TEXT,
  group_product_account_id TEXT,
  payment_method TEXT,
  payment_method_name TEXT,
  product_code TEXT,
  product_name TEXT,
  product_category TEXT,
  start_time TEXT,
  end_time TEXT,
  status_time TEXT,
  product_status TEXT,
  product_status_name TEXT,
  is_group_tagged TEXT,
  group_level TEXT,
  industry_code_1 TEXT,
  industry_name_1 TEXT,
  industry_code_2 TEXT,
  industry_name_2 TEXT,
  manager_job_no TEXT,
  manager_name TEXT,
  total_arrears REAL,
  source_created_time TEXT,
  last_month_status TEXT,
  two_months_ago_status TEXT,
  bandwidth TEXT,
  is_zero_billing_recent_6m TEXT,
  package_code TEXT,
  package_name TEXT,
  package_fee REAL,
  package_effective_time TEXT,
  package_expire_time TEXT,
  a_end_address TEXT,
  z_end_address TEXT,
  actual_monthly_fee REAL,
  actual_yearly_fee REAL,
  one_time_fee REAL,
  one_time_fee_name TEXT,
  one_time_fee_billing_month TEXT,
  contract_no TEXT,
  contract_start_date TEXT,
  contract_end_date TEXT,
  renewal_status TEXT,
  renewal_reminder_date TEXT,
  customer_contact TEXT,
  customer_phone TEXT,
  operation_owner TEXT,
  business_owner TEXT,
  project_name TEXT,
  ledger_status TEXT,
  remark TEXT,
  import_batch_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leased_line_product_code
ON leased_line(group_product_code)
WHERE group_product_code IS NOT NULL AND group_product_code <> '';

CREATE INDEX IF NOT EXISTS idx_leased_line_search
ON leased_line(group_name, group_user_name, product_name, manager_name);

CREATE INDEX IF NOT EXISTS idx_leased_line_status
ON leased_line(product_status_name, ledger_status);

CREATE TABLE IF NOT EXISTS import_batch (
  id TEXT PRIMARY KEY,
  file_name TEXT,
  sheet_name TEXT,
  total_rows INTEGER DEFAULT 0,
  success_rows INTEGER DEFAULT 0,
  failed_rows INTEGER DEFAULT 0,
  duplicate_rows INTEGER DEFAULT 0,
  updated_rows INTEGER DEFAULT 0,
  imported_by TEXT,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
  status TEXT,
  message TEXT
);

CREATE TABLE IF NOT EXISTS import_row_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT,
  row_number INTEGER,
  result TEXT,
  message TEXT,
  related_line_id INTEGER
);

CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leased_line_id INTEGER,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  changed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  change_source TEXT
);
`;
