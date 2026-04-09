/**
 * database.js — SQL Server via mssql
 * Exports: init, getPool, getExtPool, sql
 */
require('dotenv').config();
const mssql = require('mssql');

let pool    = null; // cs_team DB
let extPool = null; // LicenseDB (external)

const sql = mssql;

// ── Main DB config (cs_team) ──────────────────────────────
const mainConfig = {
  server:   process.env.DB_SERVER   || 'localhost',
  database: process.env.DB_NAME     || 'cs_team',
  user:     process.env.DB_USER     || 'cs',
  password: process.env.DB_PASSWORD || '',
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
  server:   extHost,
  port:     extPortStr ? parseInt(extPortStr) : 1433,
  database: process.env.EXT_DB_NAME     || 'LicenseDB',
  user:     process.env.EXT_DB_USER     || 'cs',
  password: process.env.EXT_DB_PASSWORD || '',
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
  }
}

function getPool()    { return pool; }
function getExtPool() { return extPool; }

module.exports = { init, getPool, getExtPool, sql };
