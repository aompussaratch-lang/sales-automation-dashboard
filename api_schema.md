# API Contract — ระบบสรุปข้อมูลฝ่ายขายอัตโนมัติ

เอกสารนี้กำหนดรูปแบบข้อมูล (JSON) ที่ backend ต้องส่งให้ frontend (ตาม `sales_summary_dashboard.jsx`)
เพื่อให้ทั้งสองฝั่งพัฒนาคู่ขนานกันได้โดยไม่ต้องรอกัน — frontend ใช้ mock data รูปแบบเดียวกันนี้อยู่แล้ว
เมื่อ backend พร้อม แค่เปลี่ยนจาก mock เป็น fetch จริงตาม endpoint ด้านล่าง

ทุก endpoint คืนค่า `Content-Type: application/json` และควรมี auth header (ดูหัวข้อ Authentication)

---

## 1. Authentication

ทุก request (ยกเว้น `POST /auth/login`) ต้องแนบ:

```
Authorization: Bearer <token>
```

ระบบต้องรู้ role ของผู้ใช้จาก token เพื่อบังคับสิทธิ์ฝั่ง backend ด้วย (ห้ามพึ่งการซ่อนปุ่มฝั่ง frontend อย่างเดียว)

| Role       | อัพโหลดไฟล์ | ดู dashboard | ดาวน์โหลดรายงาน |
|------------|:-----------:|:------------:|:----------------:|
| `sales`    | ✅          | ✅           | ✅                |
| `manager`  | ❌          | ✅           | ✅                |
| `executive`| ❌          | ✅           | ✅                |

```json
// GET /auth/me
{
  "id": "u_1023",
  "name": "สมชาย ใจดี",
  "role": "sales"
}
```

---

## 2. อัพโหลดไฟล์

### `POST /uploads`
รับไฟล์ Calendar (PDF) และ/หรือ Cancelled (Excel/CSV) — multipart/form-data, ฟิลด์ `files[]`
เฉพาะ role `sales` เท่านั้น (backend ต้องเช็ค role ก่อนรับไฟล์เสมอ)

**Response** (`202 Accepted` — ประมวลผลเป็น background job):
```json
{
  "jobId": "job_8841",
  "status": "processing",
  "files": [
    { "fileName": "Calendar_2026-08.pdf", "type": "calendar" },
    { "fileName": "Cancelled_2026-08.xlsx", "type": "cancelled" }
  ]
}
```

### `GET /uploads/{jobId}/status`
Frontend poll ทุก ~1.5 วินาที เพื่อขับ progress bar (ดู `processingStage` ใน dashboard)

```json
{
  "jobId": "job_8841",
  "status": "processing",       // "processing" | "done" | "failed"
  "stage": "parsing",           // "uploading" | "parsing" | "syncing_drive"
  "progress": 64,                // 0-100
  "error": null
}
```

เมื่อ `status: "done"` — frontend เรียก endpoint สรุปข้อมูล (หัวข้อ 4) ใหม่อีกครั้งเพื่อรีเฟรช dashboard

### `GET /uploads/history`
สำหรับตาราง "ประวัติการอัพโหลดไฟล์" — เฉพาะ role `sales`

```json
{
  "items": [
    {
      "id": "up_001",
      "fileName": "Calendar_2026-08.pdf",
      "type": "Calendar",
      "uploadedBy": "สมชาย ใจดี",
      "uploadedAt": "2026-08-31T09:14:00+07:00",
      "fileStatus": "ผ่าน",           // "ผ่าน" | "แก้ไขคอลัมน์" | "ไม่ผ่าน"
      "driveStatus": "synced"          // "synced" | "syncing" | "failed"
    }
  ]
}
```

---

## 3. Google Drive sync

### `GET /drive/status`
```json
{
  "status": "synced",              // "synced" | "syncing" | "failed"
  "lastSyncAt": "2026-08-31T09:14:00+07:00"
}
```

---

## 4. ข้อมูลสรุป (สำหรับ Dashboard)

ทุก endpoint ในหัวข้อนี้รับ query parameter `from` และ `to` (รูปแบบ `YYYY-MM-DD`) ตามช่วงวันที่ที่เลือกบน dashboard

### `GET /summary/kpi?from=2026-08-01&to=2026-08-31`
```json
{
  "cancelledJobs": { "current": 47, "previous": 42 },
  "cancelledCustomers": { "current": 47, "previous": 51 },
  "confirmedTotal": { "current": 72, "previous": 68 },
  "topCancelReason": { "reason": "เปลี่ยนวันจัดงาน", "count": 14 }
}
```
> `previous` = ค่าของช่วงเวลาเดียวกันในรอบก่อนหน้า (backend เป็นคนคำนวณ ไม่ใช่ frontend) — ใช้ขับ trend badge (▲/▼ %)

### `GET /summary/cancellations?from=&to=`
ตรงกับ "ส่วนที่ 1: สรุปยอดยกเลิก" ทั้งหมด
```json
{
  "byCustomerType": [
    { "name": "ลค.A", "value": 18 },
    { "name": "ลค.B", "value": 14 },
    { "name": "ลค.C", "value": 9 },
    { "name": "ลค.N", "value": 6 }
  ],
  "byJobType": [
    { "name": "MT", "value": 12 },
    { "name": "Audition", "value": 3 },
    { "name": "ED", "value": 9 },
    { "name": "WD", "value": 14 },
    { "name": "WL", "value": 5 },
    { "name": "DN", "value": 4 }
  ],
  "reasons": [
    { "reason": "เปลี่ยนวันจัดงาน", "count": 14 },
    { "reason": "งบประมาณไม่เพียงพอ", "count": 11 }
  ],
  "salesRanking": [
    { "name": "สมชาย ใจดี", "count": 9 },
    { "name": "วิภา รุ่งเรือง", "count": 8 }
  ]
}
```

### `GET /summary/job-status?from=&to=`
ตรงกับ "ส่วนที่ 2: ประเภทงาน × สถานะ"
```json
{
  "data": [
    { "name": "MT", "confirmed": 10, "pending": 4, "cancelled": 12 },
    { "name": "WD", "confirmed": 22, "pending": 6, "cancelled": 14 }
  ]
}
```

### `GET /summary/pax-bins?from=&to=`
ตรงกับ "ส่วนที่ 3: จำนวนงานแบ่งตามช่วงจำนวนคน"
```json
{
  "bins": [
    { "name": "น้อยกว่า 150", "value": 22 },
    { "name": "150–300", "value": 31 },
    { "name": "300–500", "value": 18 },
    { "name": "มากกว่า 500", "value": 9 }
  ]
}
```

### `GET /summary/manpower-calendar?from=&to=`
ตรงกับ "ส่วนที่ 4: งานยืนยันแล้ว รายวัน/รายสัปดาห์" — backend ส่งมาเป็นรายวันตรง ๆ (ไม่ต้องจัดกลุ่มเป็นสัปดาห์ frontend จัดเอง)
```json
{
  "days": [
    {
      "date": "2026-08-01",
      "count": 5,
      "totalPax": 640,
      "jobs": [
        { "type": "MT", "pax": 120, "time": "ช่วงเช้า" },
        { "type": "WD", "pax": 300, "time": "ช่วงเย็น" }
      ]
    }
  ]
}
```

---

## 5. ดาวน์โหลดรายงาน

### `GET /reports/export?format=pdf&from=&to=`
### `GET /reports/export?format=csv&from=&to=`
คืนไฟล์ตรง ๆ (`Content-Disposition: attachment`) ไม่ใช่ JSON

---

## 6. รายละเอียดเจาะจง (สำหรับคลิกกราฟดู drill-down)

แทนที่จะสุ่ม mock ฝั่ง frontend เหมือนตอนนี้ ระบบจริงควรมี endpoint กลาง:

### `GET /events?from=&to=&customerType=&jobType=&status=&paxMin=&paxMax=`
Query parameter ใส่เฉพาะตัวที่เกี่ยวข้องกับกราฟที่คลิก (เช่น คลิกแท่ง "ลค.A" → `customerType=A`)

```json
{
  "items": [
    {
      "eventName": "งานเลี้ยงบริษัท เอ",
      "date": "2026-08-15",
      "customerType": "A",
      "jobType": "WD",
      "status": "cancelled",
      "reason": "เปลี่ยนวันจัดงาน",
      "sales": "สมชาย ใจดี",
      "pax": 320
    }
  ]
}
```

---

## หมายเหตุสำหรับทีม backend

- ทุกตัวเลขที่เป็น aggregate (KPI, กราฟ) ควรคำนวณฝั่ง backend/database ไม่ใช่ frontend — frontend มีหน้าที่แค่ "แสดงผล"
- ฟิลด์ `previous` ใน `/summary/kpi` ต้องคำนวณจากช่วงเวลาเดียวกันของรอบก่อนหน้า (เช่น เดือนก่อน หรือช่วงวันที่เดียวกันแบบ shift ไป 1 เดือน) — ควรตกลงนิยามให้ชัดกับผู้ใช้งานจริงก่อน เพราะมีได้หลายแบบ
- `manpower-calendar` แนะนำให้ backend ส่งเป็นรายวันเสมอ ให้ frontend จัดกลุ่มเป็นสัปดาห์เอง (โค้ดใน dashboard มี `buildManpowerCalendar` รองรับ logic นี้อยู่แล้ว)
