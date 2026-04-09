# วิธีเริ่มใช้งาน CS Team Manager

## ขั้นตอน

1. เปิด Terminal แล้ว `cd` ไปที่โฟลเดอร์ `cs-team-app`
2. รันคำสั่ง:
   ```
   node server.js
   ```
3. เปิด Browser แล้วไปที่ `http://localhost:3000`

## โครงสร้างไฟล์

```
cs-team-app/
├── server.js       ← Express API server
├── database.js     ← SQLite (sql.js) setup + seed data
├── csdb.sqlite     ← ไฟล์ฐานข้อมูล (สร้างอัตโนมัติ)
├── package.json
└── public/
    └── index.html  ← Web App ภาษาไทย
```

## หน้าที่มี

| หน้า | คำอธิบาย |
|------|-----------|
| 📊 Dashboard | ภาพรวมเคส / กะปัจจุบัน / เคสค้าง / KPI |
| 📅 ตารางกะ | ดู/กำหนดกะรายสัปดาห์ / ขออนุมัติวันหยุด |
| 🎫 ติดตามเคส | เปิด/แก้ไข/Escalate Ticket |
| 📈 ประเมินผล | บันทึก KPI รายเดือน + กราฟเปรียบเทียบ |

## API Endpoints

- `GET  /api/employees`
- `GET  /api/shifts?week_start=YYYY-MM-DD`
- `POST /api/shifts`
- `GET  /api/leave-requests`
- `POST /api/leave-requests`
- `PUT  /api/leave-requests/:id/approve`
- `GET  /api/tickets`
- `POST /api/tickets`
- `PUT  /api/tickets/:id`
- `POST /api/tickets/:id/escalate`
- `GET  /api/kpi`
- `POST /api/kpi`
- `GET  /api/dashboard`
