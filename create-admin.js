/**
 * สร้าง admin user คนแรกในระบบ
 * ใช้: node create-admin.js [username] [password] [role]
 * ตัวอย่าง: node create-admin.js admin Admin@1234 admin
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { init, getPool, sql } = require('./database');

async function main() {
  const username = process.argv[2] || 'admin';
  const password = process.argv[3] || 'Admin@1234';
  const role     = process.argv[4] || 'admin';

  console.log('🔌 เชื่อมต่อ database...');
  await init();
  const pool = getPool();

  // Check if user already exists
  const existing = await pool.request()
    .input('uname', sql.NVarChar, username)
    .query('SELECT id FROM app_users WHERE username=@uname');

  if (existing.recordset.length > 0) {
    console.log(`⚠️  User "${username}" มีอยู่แล้ว (id=${existing.recordset[0].id})`);
    console.log('ถ้าต้องการ reset รหัสผ่าน ให้เพิ่ม --reset flag หรือใช้หน้าจัดการ User');
    process.exit(0);
  }

  const hash = await bcrypt.hash(password, 10);

  await pool.request()
    .input('uname', sql.NVarChar, username)
    .input('hash',  sql.NVarChar, hash)
    .input('role',  sql.NVarChar, role)
    .query(`INSERT INTO app_users (username, password_hash, role)
            VALUES (@uname, @hash, @role)`);

  console.log('');
  console.log('✅ สร้าง user สำเร็จ!');
  console.log(`   Username : ${username}`);
  console.log(`   Password : ${password}`);
  console.log(`   Role     : ${role}`);
  console.log('');
  console.log('👉 เข้าสู่ระบบที่ http://localhost:3010');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
