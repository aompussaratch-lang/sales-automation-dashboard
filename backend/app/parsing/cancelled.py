"""
Parser สำหรับไฟล์ Cancelled (.xlsx) — ดัดแปลงจาก parse_cancelled.py เดิม (root ของโปรเจกต์)
เก็บ logic การแกะข้อความหลักไว้ทั้งหมด (regex, categorize_reason, find_job_type) เพียงแค่:
  - คืนค่าเป็น list[dict] ของ "แถวดิบ" แทนที่จะ aggregate ทันที เพื่อให้ backend เอาไป
    กรองตามช่วงวันที่ (from/to) ก่อน aggregate ได้ตาม api_schema.md
  - เพิ่มการอ่านคอลัมน์ F (Event Date, รูปแบบ "DD/MM/YY - DD/MM/YY") และคอลัมน์ I (Customer)
    ซึ่งสคริปต์ต้นฉบับไม่ได้ใช้ — จำเป็นสำหรับ query parameter from/to ที่ api_schema.md กำหนด
    (ตรวจคอลัมน์จากไฟล์จริง Cancelled.xlsx แถว header ที่ 7 ด้วย openpyxl)

⚠️ คงคำเตือนเดิมจากสคริปต์ต้นฉบับไว้: "เหตุผลยกเลิก" เป็นข้อความอิสระ, categorize_reason() เป็นแค่
   keyword heuristic เบื้องต้น, และมีโค้ดประเภทงาน "EN" ที่ไม่อยู่ใน schema เดิม — ควรให้ทีมขายช่วยตรวจ
"""

import re
from datetime import date, datetime
from pathlib import Path

import openpyxl
from openpyxl.utils import get_column_letter

HEADER_ROW = 7
COL_QTN = "A"
COL_EVENT_NAME = "C"
COL_EVENT_DATE = "F"
COL_CUSTOMER = "I"
COL_SALE = "N"
COL_STATUS = "Q"
CANCEL_STATUS_VALUES = {"Cancel"}

# ลำดับสำคัญ: โค้ดที่ยาว/เฉพาะเจาะจงกว่าควรมาก่อน เพื่อกันจับคู่ผิด (เช่น "Audition" ต้องมาก่อน "DN")
JOB_CODES = ["Audition", "MT", "WD", "DN", "WL", "EN", "ED"]

CUSTOMER_RE = re.compile(r"ลค\.?\s*-?\s*([ABCN])\b", re.IGNORECASE)
PAX_RE = re.compile(r"(\d+)(?:[-–](\d+))?\s*P\b", re.IGNORECASE)
DATE_TOKEN_RE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{2,4})")

# keyword -> หมวดเหตุผล (heuristic เบื้องต้น ต้องให้ทีมขายช่วยตรวจ/ปรับ)
REASON_KEYWORDS = [
    ("เลือก รร. อื่น|เลือกรร.อื่น|เลือกจัด รร\\.", "เปลี่ยนไปใช้โรงแรมอื่น"),
    ("งบ", "งบประมาณไม่เพียงพอ"),
    ("คนสมัครน้อย|ผู้สมัครน้อย|คนน้อย|ผู้สมัครไม่ได้ตามเป้า", "จำนวนผู้เข้าร่วมน้อยกว่าเป้า"),
    ("ห้อง.*ไม่ว่าง|ไม่มีห้อง", "ห้องประชุม/สถานที่ไม่ว่าง"),
    ("เดินทาง", "ปัญหาการเดินทาง"),
    ("ที่จอดรถ", "ที่จอดรถไม่เพียงพอ"),
    ("เปลี่ยน.*สถานที่|ไปจัดที่|ย้ายไปจัด", "เปลี่ยนสถานที่จัดงาน"),
    ("เลื่อนวัน|เปลี่ยนวัน", "เปลี่ยนวันจัดงาน"),
]


def categorize_reason(raw_reason: str) -> str:
    for pattern, label in REASON_KEYWORDS:
        if re.search(pattern, raw_reason):
            return label
    return "อื่น ๆ"


def find_job_type(text: str):
    """หา job code ที่ปรากฏเร็วที่สุดในข้อความ (ไม่ใช่ตามลำดับ priority ใน list)"""
    candidates = []
    for code in JOB_CODES:
        for m in re.finditer(rf"(?<![A-Za-z]){re.escape(code)}(?![A-Za-z])", text):
            candidates.append((m.start(), code))
    if not candidates:
        return None, -1
    candidates.sort()
    return candidates[0][1], candidates[0][0]


def extract_fields_from_event_name(text: str) -> dict:
    if not isinstance(text, str):
        return {"job_type": None, "customer_type": None, "pax": None, "reason": ""}

    job_type, pos = find_job_type(text)
    raw_reason = text[:pos] if pos >= 0 else text
    raw_reason = re.sub(r"^CX[LK]\.?", "", raw_reason).strip()
    raw_reason = re.sub(r"\s*เดิม\s*(CFM\.)?\s*$", "", raw_reason).strip(" .")

    cust_match = CUSTOMER_RE.search(text)
    customer_type = cust_match.group(1).upper() if cust_match else None

    pax_match = PAX_RE.search(text)
    pax = None
    if pax_match:
        lo = int(pax_match.group(1))
        hi = int(pax_match.group(2)) if pax_match.group(2) else lo
        pax = round((lo + hi) / 2)

    return {
        "job_type": job_type,
        "customer_type": customer_type,
        "pax": pax,
        "reason": raw_reason,
    }


def parse_event_date(value) -> date | None:
    """คอลัมน์ Event Date เป็นข้อความ 'DD/MM/YY - DD/MM/YY' (ช่วงวัน เริ่ม-จบ) — เอาวันเริ่มมาใช้กรอง"""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        return None
    m = DATE_TOKEN_RE.search(value)
    if not m:
        return None
    day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if year < 100:
        year += 2000
    try:
        return date(year, month, day)
    except ValueError:
        return None


def load_cancelled_rows(path: Path) -> list[dict]:
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[wb.sheetnames[0]]

    rows = []
    for row in ws.iter_rows(min_row=HEADER_ROW + 1, max_row=ws.max_row):
        by_col = {get_column_letter(c.column): c.value for c in row}
        qtn = by_col.get(COL_QTN)
        status = by_col.get(COL_STATUS)
        event_name = by_col.get(COL_EVENT_NAME)
        if not qtn or not str(qtn).startswith("QN"):
            continue
        if status not in CANCEL_STATUS_VALUES:
            continue

        extracted = extract_fields_from_event_name(event_name)
        customer_name = by_col.get(COL_CUSTOMER)
        rows.append(
            {
                "qtn": qtn,
                "event_date": parse_event_date(by_col.get(COL_EVENT_DATE)),
                "customer_name": (str(customer_name).strip() if customer_name else None),
                "sales": (by_col.get(COL_SALE) or "").strip() or None,
                "job_type": extracted["job_type"],
                "customer_type": extracted["customer_type"],
                "pax": extracted["pax"],
                "raw_reason": extracted["reason"],
                "reason_category": categorize_reason(extracted["reason"]),
            }
        )
    return rows
