# Sales Automation API (backend)

FastAPI backend สำหรับ `api_schema.md` — logic แกะไฟล์หลักมาจาก `parse_cancelled.py` และ
`parse_calendar_excel.py` เดิม (ย้ายมาไว้ใน `app/parsing/` แทบไม่แก้ core regex/heuristic เลย)

## ติดตั้ง (ต้องมี Python 3.10+)

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
```

## รัน

```bash
uvicorn app.main:app --reload --port 8000
```

พอเริ่มทำงาน backend จะโหลด `Cancelled.xlsx` และ `Function_Calendar.xlsx` (ไฟล์จริงที่อยู่ root ของ
โปรเจกต์นี้อยู่แล้ว) เข้ามาเป็นข้อมูลตั้งต้นทันที — เปิด http://localhost:8000/docs เพื่อดู/ทดสอบทุก
endpoint แบบ interactive (Swagger UI ที่ FastAPI สร้างให้อัตโนมัติ)

## Auth (demo เท่านั้น)

ยังไม่มีระบบ login จริง — ใช้ bearer token คงที่ 3 ตัวแทน 3 role (ดู `app/auth.py`):

| Role      | Token                  |
|-----------|------------------------|
| sales     | `sales-demo-token`     |
| manager   | `manager-demo-token`   |
| executive | `executive-demo-token` |

```
Authorization: Bearer sales-demo-token
```

⚠️ ก่อนขึ้น production ต้องเปลี่ยนเป็นระบบ auth จริง (login endpoint ออก JWT, เก็บ user ใน database)

## ข้อจำกัด/สมมติฐานที่ควรตรวจกับทีมขายก่อนใช้งานจริง

รายการเดิมจาก `parse_cancelled.py`/`parse_calendar_excel.py` ยังใช้ได้ทั้งหมด (โค้ดงาน "EN" ที่ไม่อยู่ใน
schema, `categorize_reason()` เป็น keyword heuristic, ไฟล์ปฏิทินจริงเป็น .xlsx ไม่ใช่ PDF ตามสเปกเดิม)
เพิ่มเติมจากตอนต่อ backend:

- **นิยาม "previous period" ใน `/summary/kpi`**: ใช้ "ช่วงเวลาความยาวเท่ากัน ต่อเนื่องก่อนหน้าทันที"
  (ดู `app/aggregate.py::previous_period`) — เป็นแค่ค่า default ที่เลือกเอง ควรถามผู้ใช้งานจริง
- **job_type ของ event ในปฏิทิน**: ไฟล์ Function_Calendar.xlsx ไม่มีคอลัมน์ประเภทงานแยก จึงเดาจาก
  ข้อความ title ด้วย regex เดียวกับที่ใช้กับ Cancelled.xlsx (`find_job_type`) — ยังไม่เคยตรวจความแม่นยำ
  กับข้อมูลจริงจำนวนมาก ควรให้ทีมขายช่วย validate ก่อนใช้กราฟ "ประเภทงาน × สถานะ" ตัดสินใจอะไรสำคัญ
- **"pending" ใน `/summary/job-status`**: จะเป็น 0 เสมอจนกว่าจะมีไฟล์ปฏิทิน export สถานะ Not Confirm/
  Cut off เพิ่ม (`POST /uploads` รองรับอัพโหลดหลายไฟล์ปฏิทินแยกสถานะ — ตอนนี้ endpoint fix สถานะเป็น
  "Confirmed" เสมอ เพราะยังไม่มี UI ให้เลือกสถานะไฟล์ตอนอัพโหลด)
- **`/reports/export`**: CSV เป็นรายการ "cancelled events" ในช่วงที่เลือกจริง, PDF เป็นสรุป KPI/เหตุผลยกเลิก
  หน้าเดียวแบบเรียบง่าย (ไม่ได้ทำเลย์เอาต์ให้ตรงหน้า dashboard เป๊ะ)
