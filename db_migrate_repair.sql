-- ═══════════════════════════════════════════════════════════
--  CS Team — Repair Job System Migration
--  Database: cs_team
--  Run this in SSMS before starting the app
-- ═══════════════════════════════════════════════════════════

USE cs_team;
GO

-- ── 1. repair_jobs ────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='repair_jobs' AND xtype='U')
CREATE TABLE repair_jobs (
  id                          INT PRIMARY KEY IDENTITY,
  job_no                      NVARCHAR(20)   NOT NULL UNIQUE,   -- RJ-202604-0012

  -- ── แจ้งซ่อม ──────────────────────────────────────────
  reported_at                 DATETIME       DEFAULT GETDATE(),
  device_type                 NVARCHAR(100),                    -- Printer / POS / etc.
  device_model                NVARCHAR(100),
  vendor                      NVARCHAR(100),                    -- ผู้จัดจำหน่าย
  registration_id             INT,                              -- FK CustomerRegistration (LicenseDB)
  company_name                NVARCHAR(255),                    -- ชื่อร้าน (cache จาก LicenseDB)
  serial_no                   NVARCHAR(100),
  symptom                     NVARCHAR(MAX),                    -- อาการเสีย
  initial_fix                 NVARCHAR(MAX),                    -- การแก้ไขเบื้องต้น
  contact_name                NVARCHAR(100),
  contact_phone               NVARCHAR(50),
  line_id                     NVARCHAR(100),                    -- Line ID หรือ Line Group Name
  warranty                    BIT            DEFAULT 0,         -- 1=อยู่ในประกัน
  warranty_expire             DATE,
  device_location             NVARCHAR(255),                    -- จุดวางเครื่อง
  reported_by                 INT,                              -- FK app_users.id

  -- ── Admin Updates ─────────────────────────────────────
  status                      NVARCHAR(30)   DEFAULT 'received',
  -- received | assessing | quoted | waiting_approval |
  -- device_received | sent_supplier | returned_from_supplier |
  -- returned_to_customer | closed | cancelled

  finance_status              NVARCHAR(30)   DEFAULT 'pending',
  -- pending | quoted | approved | so_issued | paid

  quote_date                  DATE,
  quote_no                    NVARCHAR(50),
  received_date               DATE,                             -- วันที่รับเครื่องจากร้าน
  sent_supplier_date          DATE,                             -- วันที่ส่ง supplier
  returned_from_supplier_date DATE,                             -- วันที่ได้เครื่องคืนจาก supplier
  returned_to_customer_date   DATE,                             -- วันที่ส่งคืนลูกค้า
  spare_serial_no             NVARCHAR(100),                    -- S/N เครื่องสแปร์
  taken_back_items            NVARCHAR(MAX),                    -- อุปกรณ์นำกลับ
  remark                      NVARCHAR(MAX),

  -- ── Meta ──────────────────────────────────────────────
  created_at                  DATETIME       DEFAULT GETDATE(),
  updated_at                  DATETIME       DEFAULT GETDATE(),
  updated_by                  INT
);
GO

-- ── 2. repair_attachments ─────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='repair_attachments' AND xtype='U')
CREATE TABLE repair_attachments (
  id            INT PRIMARY KEY IDENTITY,
  repair_id     INT            NOT NULL,
  file_type     NVARCHAR(30)   NOT NULL,
  -- device_photo | quotation | so | payment | other
  file_name     NVARCHAR(255)  NOT NULL,
  file_path     NVARCHAR(500)  NOT NULL,   -- relative path on disk
  file_size     INT,                       -- bytes
  uploaded_by   INT,
  uploaded_at   DATETIME       DEFAULT GETDATE(),
  CONSTRAINT FK_attach_job FOREIGN KEY (repair_id) REFERENCES repair_jobs(id) ON DELETE CASCADE
);
GO

-- ── 3. repair_timeline ────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='repair_timeline' AND xtype='U')
CREATE TABLE repair_timeline (
  id            INT PRIMARY KEY IDENTITY,
  repair_id     INT            NOT NULL,
  field_changed NVARCHAR(50),             -- 'status' | 'finance_status' | 'remark' etc.
  old_value     NVARCHAR(255),
  new_value     NVARCHAR(255),
  changed_by    INT,
  changed_at    DATETIME       DEFAULT GETDATE(),
  note          NVARCHAR(500),
  CONSTRAINT FK_timeline_job FOREIGN KEY (repair_id) REFERENCES repair_jobs(id) ON DELETE CASCADE
);
GO

-- ── 4. repair_notification_log ────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='repair_notification_log' AND xtype='U')
CREATE TABLE repair_notification_log (
  id            INT PRIMARY KEY IDENTITY,
  repair_id     INT            NOT NULL,
  channel       NVARCHAR(10)   NOT NULL,  -- 'line' | 'email'
  recipient     NVARCHAR(255),
  message       NVARCHAR(MAX),
  status        NVARCHAR(10)   DEFAULT 'sent',  -- 'sent' | 'failed'
  error_msg     NVARCHAR(500),
  sent_at       DATETIME       DEFAULT GETDATE(),
  CONSTRAINT FK_notif_job FOREIGN KEY (repair_id) REFERENCES repair_jobs(id) ON DELETE CASCADE
);
GO

-- ── Index สำหรับ query ─────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_repair_jobs_status')
  CREATE INDEX IX_repair_jobs_status ON repair_jobs(status);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_repair_jobs_reported_at')
  CREATE INDEX IX_repair_jobs_reported_at ON repair_jobs(reported_at DESC);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_repair_jobs_company')
  CREATE INDEX IX_repair_jobs_company ON repair_jobs(company_name);
GO

PRINT 'Migration complete: repair_jobs, repair_attachments, repair_timeline, repair_notification_log';
GO
