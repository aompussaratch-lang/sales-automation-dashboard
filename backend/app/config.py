"""
ค่าตั้งต้นของ backend — ปรับผ่าน environment variable ได้ทั้งหมด (ไม่ต้องแก้โค้ด)
"""

import os
from pathlib import Path

# โฟลเดอร์โปรเจกต์ (ที่ Cancelled.xlsx / Function_Calendar.xlsx วางอยู่จริงตอนนี้)
PROJECT_ROOT = Path(__file__).resolve().parents[2]

# ไฟล์ตัวอย่างจริงที่ใช้ seed ข้อมูลตอน backend เริ่มทำงาน (ให้ dashboard มีข้อมูลให้ดูทันทีโดยไม่ต้องอัพโหลดก่อน)
SEED_CANCELLED_FILE = Path(os.environ.get("SEED_CANCELLED_FILE", PROJECT_ROOT / "Cancelled.xlsx"))
SEED_CALENDAR_FILE = Path(os.environ.get("SEED_CALENDAR_FILE", PROJECT_ROOT / "Function_Calendar.xlsx"))

# โฟลเดอร์เก็บไฟล์ที่อัพโหลดเข้ามาจริงระหว่างรัน
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", PROJECT_ROOT / "backend" / "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# origin ฝั่ง frontend (dev server) สำหรับ CORS — ปรับเป็น origin จริงตอน deploy
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")
