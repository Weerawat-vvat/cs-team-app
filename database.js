/**
 * database.js — SQL Server via mssql
 * Exports: init, getPool, getExtPool, sql
 */
require('dotenv').config();
const mssql = require('mssql');

let pool       = null; // cs_team DB
let extPool    = null; // LicenseDB (external)
let infoPool   = null; // INFO_BKK (inventory/serial)
let lineBotPool = null; // LineBotMonitor (LINE webhook monitor)

const sql = mssql;

// ── Main DB config (cs_team) ──────────────────────────────
const mainConfig = {
  server:         process.env.DB_SERVER   || 'localhost',
  database:       process.env.DB_NAME     || 'cs_team',
  user:           process.env.DB_USER     || 'cs',
  password:       process.env.DB_PASSWORD || '',
  requestTimeout: 60000,  // 60s (default 15s is too short)
  options: {
    encrypt:              process.env.DB_ENCRYPT     === 'true',
    trustServerCertificate: process.env.DB_TRUST_CERT !== 'false',
    enableArithAbort:     true,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

// ── External DB config (LicenseDB) ───────────────────────
// รองรับ format "host,port" หรือ "host" เฉยๆ
const extServerRaw = process.env.EXT_DB_SERVER || '';
const [extHost, extPortStr] = extServerRaw.split(',');
const extConfig = {
  server:         extHost,
  port:           extPortStr ? parseInt(extPortStr) : 1433,
  database:       process.env.EXT_DB_NAME     || 'LicenseDB',
  user:           process.env.EXT_DB_USER     || 'cs',
  password:       process.env.EXT_DB_PASSWORD || '',
  requestTimeout: 60000,  // 60s
  options: {
    encrypt:              process.env.EXT_DB_ENCRYPT     === 'true',
    trustServerCertificate: process.env.EXT_DB_TRUST_CERT !== 'false',
    enableArithAbort:     true,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

// ── Init ──────────────────────────────────────────────────
async function init() {
  // เชื่อมต่อ Main DB
  try {
    pool = await mssql.connect(mainConfig);
    console.log(`✅ Connected to SQL Server — ${mainConfig.server}/${mainConfig.database}`);
  } catch (err) {
    console.error('❌ Main DB connection failed:', err.message);
    throw err;
  }

  // Run migrations
  try {
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='employees' AND xtype='U')
      CREATE TABLE employees (
        id         INT IDENTITY(1,1) PRIMARY KEY,
        name       NVARCHAR(100) NOT NULL,
        nickname   NVARCHAR(50),
        team       NVARCHAR(50) NOT NULL,
        role       NVARCHAR(50) NOT NULL DEFAULT 'staff',
        phone      NVARCHAR(20),
        start_date DATE,
        active     BIT DEFAULT 1,
        created_at DATETIME DEFAULT GETDATE()
      )
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='shifts' AND xtype='U')
      CREATE TABLE shifts (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        employee_id INT REFERENCES employees(id),
        shift_type  NVARCHAR(20) NOT NULL,
        shift_date  DATE NOT NULL,
        status      NVARCHAR(20) DEFAULT 'scheduled'
      )
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='leave_requests' AND xtype='U')
      CREATE TABLE leave_requests (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        employee_id INT REFERENCES employees(id),
        leave_date  DATE NOT NULL,
        reason      NVARCHAR(500),
        status      NVARCHAR(20) DEFAULT 'pending',
        approved_by INT REFERENCES employees(id),
        created_at  DATETIME DEFAULT GETDATE()
      )
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='kpi_comments' AND xtype='U')
      CREATE TABLE kpi_comments (
        id           INT IDENTITY(1,1) PRIMARY KEY,
        ext_username NVARCHAR(100) NOT NULL,
        month        DATE NOT NULL,
        comment      NVARCHAR(1000),
        recorded_by  INT REFERENCES employees(id),
        created_at   DATETIME DEFAULT GETDATE()
      )
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='kpi_activities' AND xtype='U')
      CREATE TABLE kpi_activities (
        id               INT IDENTITY(1,1) PRIMARY KEY,
        ext_username     NVARCHAR(100) NOT NULL,
        month            DATE NOT NULL,
        kb_articles      INT DEFAULT 0,
        trainings        INT DEFAULT 0,
        escalations_reduced INT DEFAULT 0,
        recorded_by      INT REFERENCES employees(id),
        updated_at       DATETIME DEFAULT GETDATE(),
        UNIQUE (ext_username, month)
      )
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='kpi_targets' AND xtype='U')
      BEGIN
        CREATE TABLE kpi_targets (
          id           INT IDENTITY(1,1) PRIMARY KEY,
          role_key     NVARCHAR(50) NOT NULL UNIQUE,
          target_grade INT NOT NULL DEFAULT 1500,
          label        NVARCHAR(100),
          updated_at   DATETIME DEFAULT GETDATE()
        )
        INSERT INTO kpi_targets(role_key,target_grade,label) VALUES
          ('helpdesk',   1500, 'Helpdesk'),
          ('specialist_ticket', 500, 'Specialist ติดตามเคส'),
          ('specialist',  800, 'Specialist')
      END
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='kpi_punctuality' AND xtype='U')
      CREATE TABLE kpi_punctuality (
        id           INT IDENTITY(1,1) PRIMARY KEY,
        ext_username NVARCHAR(100) NOT NULL,
        month        DATE NOT NULL,
        score        INT NOT NULL DEFAULT 0,
        recorded_by  INT REFERENCES employees(id),
        updated_at   DATETIME DEFAULT GETDATE(),
        UNIQUE (ext_username, month)
      )
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='kpi_trainings' AND xtype='U')
      CREATE TABLE kpi_trainings (
        id           INT IDENTITY(1,1) PRIMARY KEY,
        trainer_ext  NVARCHAR(100) NOT NULL,
        trained_date DATE NOT NULL,
        topic        NVARCHAR(300) NOT NULL,
        trainees     NVARCHAR(500),
        notes        NVARCHAR(1000),
        created_by   INT REFERENCES employees(id),
        created_at   DATETIME DEFAULT GETDATE()
      )
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='app_users' AND xtype='U')
      CREATE TABLE app_users (
        id            INT IDENTITY(1,1) PRIMARY KEY,
        employee_id   INT REFERENCES employees(id),
        username      NVARCHAR(50) NOT NULL UNIQUE,
        password_hash NVARCHAR(255) NOT NULL,
        role          NVARCHAR(20) NOT NULL DEFAULT 'staff',
        ext_username  NVARCHAR(100),
        active        BIT DEFAULT 1,
        created_at    DATETIME DEFAULT GETDATE()
      )
    `);
    // Teams table
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='teams' AND xtype='U')
      BEGIN
        CREATE TABLE teams (
          id           INT IDENTITY(1,1) PRIMARY KEY,
          name         NVARCHAR(50)  NOT NULL UNIQUE,
          display_name NVARCHAR(100) NOT NULL,
          color        NVARCHAR(20)  DEFAULT '#2563eb',
          active       BIT           DEFAULT 1,
          sort_order   INT           DEFAULT 0,
          created_at   DATETIME      DEFAULT GETDATE()
        )
        INSERT INTO teams (name, display_name, color, sort_order) VALUES
          ('call_center', 'Call Center', '#16a34a', 1),
          ('helpdesk',    'Helpdesk',    '#2563eb', 2),
          ('repair',      'Repair',      '#ca8a04', 3)
      END
    `);
    // ── Pod Assign system ─────────────────────────────────
    // pods — ทีมย่อย (Pod) ที่มีหัวหน้า + ภูมิภาค
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='pods' AND xtype='U')
      CREATE TABLE pods (
        id               INT IDENTITY(1,1) PRIMARY KEY,
        code             NVARCHAR(20)  NOT NULL UNIQUE,        -- 'BKK-1'
        display_name     NVARCHAR(100) NOT NULL,              -- 'Pod BKK-1'
        region           NVARCHAR(20)  NOT NULL DEFAULT 'BKK',-- 'BKK' | 'CM'
        lead_employee_id INT REFERENCES employees(id),        -- ★ หัวหน้า
        color            NVARCHAR(20)  DEFAULT '#1d4ed8',
        sort_order       INT           DEFAULT 0,
        active           BIT           DEFAULT 1,
        created_at       DATETIME      DEFAULT GETDATE()
      )
    `);
    // pod_members — สมาชิกใน Pod (lead/junior/member)
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='pod_members' AND xtype='U')
      CREATE TABLE pod_members (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        pod_id      INT NOT NULL REFERENCES pods(id),
        employee_id INT NOT NULL REFERENCES employees(id),
        role_in_pod NVARCHAR(20) NOT NULL DEFAULT 'member',   -- lead | junior | member
        active      BIT DEFAULT 1,
        assigned_at DATETIME DEFAULT GETDATE()
      )
    `);
    // customers — กลุ่มลูกค้าที่ assign ให้ Pod
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='customers' AND xtype='U')
      CREATE TABLE customers (
        id         INT IDENTITY(1,1) PRIMARY KEY,
        name       NVARCHAR(255) NOT NULL,
        branches   INT DEFAULT 0,                             -- จำนวนสาขา
        pod_id     INT NULL REFERENCES pods(id),              -- Pod ที่ assign (null = ยังไม่ assign)
        priority   NVARCHAR(20) DEFAULT 'green',              -- green | yellow | red (customer status)
        note       NVARCHAR(1000),
        active     BIT DEFAULT 1,
        created_at DATETIME DEFAULT GETDATE()
      )
    `);
    // customer_assignments — ประวัติการย้าย Pod ของลูกค้า
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='customer_assignments' AND xtype='U')
      CREATE TABLE customer_assignments (
        id            INT IDENTITY(1,1) PRIMARY KEY,
        customer_id   INT NOT NULL REFERENCES customers(id),
        pod_id        INT REFERENCES pods(id),
        assigned_by   INT REFERENCES employees(id),
        assigned_at   DATETIME DEFAULT GETDATE(),
        unassigned_at DATETIME NULL
      )
    `);
    // pod_shift_sr — หัวหน้ากะ (SR) ต่อช่วงเวลาของแต่ละ Pod
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='pod_shift_sr' AND xtype='U')
      CREATE TABLE pod_shift_sr (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        pod_id      INT NOT NULL REFERENCES pods(id),
        period      NVARCHAR(20) NOT NULL,            -- morning | afternoon | night
        employee_id INT REFERENCES employees(id),
        updated_at  DATETIME DEFAULT GETDATE(),
        CONSTRAINT UQ_pod_period UNIQUE (pod_id, period)
      )
    `);
    // line_group_pods — assign กลุ่มไลน์ (จาก LineBotMonitor) ให้ Pod ดูแล
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='line_group_pods' AND xtype='U')
      CREATE TABLE line_group_pods (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        group_id    NVARCHAR(100) NOT NULL UNIQUE,     -- LINE GroupId (Cxxxx)
        group_name  NVARCHAR(255),
        pod_id      INT NULL REFERENCES pods(id),
        assigned_by INT REFERENCES employees(id),
        updated_at  DATETIME DEFAULT GETDATE()
      )
    `);
    console.log('✅ Migrations done');
  } catch (err) {
    console.error('❌ Migration error:', err.message);
  }

  // เชื่อมต่อ External DB (LicenseDB) — optional
  if (process.env.EXT_DB_SERVER) {
    try {
      extPool = new mssql.ConnectionPool(extConfig);
      await extPool.connect();
      console.log(`✅ Connected to External DB — ${extConfig.server}/${extConfig.database}`);
    } catch (err) {
      console.warn('⚠️  External DB not available:', err.message);
      extPool = null;
    }

    // เชื่อมต่อ INFO_BKK (same server as LicenseDB, different database)
    if (process.env.INFO_DB_NAME) {
      try {
        const infoConfig = {
          ...extConfig,
          database: process.env.INFO_DB_NAME,
        };
        infoPool = new mssql.ConnectionPool(infoConfig);
        await infoPool.connect();
        console.log(`✅ Connected to INFO DB — ${infoConfig.server}/${infoConfig.database}`);
      } catch (err) {
        console.warn('⚠️  INFO DB not available:', err.message);
        infoPool = null;
      }
    }

    // เชื่อมต่อ LineBotMonitor (same server as LicenseDB, different database)
    try {
      const lineBotConfig = {
        ...extConfig,
        database: process.env.LINEBOT_DB_NAME || 'LineBotMonitor',
      };
      lineBotPool = new mssql.ConnectionPool(lineBotConfig);
      await lineBotPool.connect();
      console.log(`✅ Connected to LineBotMonitor DB — ${lineBotConfig.server}/${lineBotConfig.database}`);
    } catch (err) {
      console.warn('⚠️  LineBotMonitor DB not available:', err.message);
      lineBotPool = null;
    }
  }
}

function getPool()        { return pool; }
function getExtPool()     { return extPool; }
function getInfoPool()    { return infoPool; }
function getLineBotPool() { return lineBotPool; }

module.exports = { init, getPool, getExtPool, getInfoPool, getLineBotPool, sql };
