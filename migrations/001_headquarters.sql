ALTER TABLE stores ADD COLUMN unit_type TEXT NOT NULL DEFAULT 'store' CHECK (unit_type IN ('headquarters', 'store', 'partner'));
ALTER TABLE stores ADD COLUMN is_system_default INTEGER NOT NULL DEFAULT 0 CHECK (is_system_default IN (0, 1));
ALTER TABLE stores ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'));

CREATE UNIQUE INDEX idx_stores_one_system_default ON stores(is_system_default) WHERE is_system_default = 1;

INSERT INTO stores (store_name, contact_name, phone, email, platform_slug, unit_type, is_system_default, status)
SELECT 'LT 大健康成交平台總部', '總部管理員', '', '', 'lt-headquarters', 'headquarters', 1, 'active'
WHERE NOT EXISTS (SELECT 1 FROM stores WHERE platform_slug = 'lt-headquarters');

CREATE TEMP TABLE assert_system_headquarters (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO assert_system_headquarters (valid)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM stores
WHERE platform_slug = 'lt-headquarters'
  AND unit_type = 'headquarters'
  AND is_system_default = 1
  AND status = 'active';
DROP TABLE assert_system_headquarters;
