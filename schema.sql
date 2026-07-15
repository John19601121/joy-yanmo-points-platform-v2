CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  platform_slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'store', 'member')),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  store_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  is_super_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES stores(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_admin_email ON users(lower(email), role) WHERE role = 'admin';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_member_email ON users(lower(email), role) WHERE role = 'member';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_store_email_store ON users(lower(email), role) WHERE role = 'store';

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  member_code TEXT UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE (store_id, email),
  UNIQUE (store_id, phone)
);

CREATE TABLE IF NOT EXISTS point_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('purchase', 'gift', 'consume')),
  points INTEGER NOT NULL CHECK (points > 0),
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'pending', 'rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (member_id) REFERENCES members(id)
);

CREATE TABLE IF NOT EXISTS deduction_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  points INTEGER NOT NULL CHECK (points > 0),
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (member_id) REFERENCES members(id)
);

CREATE TABLE IF NOT EXISTS admin_account_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'store')),
  store_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'disabled')),
  user_id INTEGER,
  requested_by INTEGER,
  reviewed_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  disabled_at TEXT,
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (requested_by) REFERENCES users(id),
  FOREIGN KEY (reviewed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (event_type IN ('login', 'logout')),
  login_email TEXT NOT NULL,
  admin_name TEXT,
  ip TEXT,
  user_agent TEXT,
  result TEXT NOT NULL CHECK (result IN ('success', 'failed')),
  failure_reason TEXT,
  user_id INTEGER,
  event_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS product_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (type_id) REFERENCES product_types(id),
  UNIQUE (type_id, name)
);

CREATE TABLE IF NOT EXISTS media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'cloudinary',
  public_id TEXT NOT NULL UNIQUE,
  secure_url TEXT NOT NULL,
  original_filename TEXT,
  display_name TEXT,
  alt_text TEXT,
  mime_type TEXT,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  folder TEXT,
  uploaded_by_user_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type_id INTEGER NOT NULL,
  category_id INTEGER,
  short_description TEXT,
  media_asset_id INTEGER,
  image_url TEXT,
  product_page_url TEXT NOT NULL,
  price INTEGER,
  currency TEXT NOT NULL DEFAULT 'TWD',
  payment_provider TEXT NOT NULL DEFAULT 'ecpay',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (type_id) REFERENCES product_types(id),
  FOREIGN KEY (category_id) REFERENCES product_categories(id),
  FOREIGN KEY (media_asset_id) REFERENCES media_assets(id)
);
