"""
parse_cancelled.py
ประมวลผลไฟล์ Cancelled.xlsx (จริง) เป็น JSON ตามรูปแบบใน api_schema.md -> GET /summary/cancellations

ผ่านการทดสอบกับไฟล์จริง (Cancelled.xlsx) แล้ว — โครงสร้างจริงที่พบ:
  - Header อยู่แถวที่ 7: QTN# | QTN Date | Event Name | Event Date | Customer | Customer Contact | Sale | Status
  - Status ("Cancel") มีคอลัมน์ตรงอยู่แล้ว ไม่ต้องเดา
  - แต่ "ประเภทลูกค้า / ประเภทงาน / จำนวนคน / เหตุผลยกเลิก" ฝังอยู่ในคอลัมน์ Event Name เป็นข้อความอิสระ (ตรงตามที่สเปกบอกไว้จริง)
    ตัวอย่าง: "CXL. ห้องประชุมไม่ว่าง ไม่สามารถเลื่อนวันได้  เดิม MT ไม่ระบุห้อง 300P ลค.N - Tel"

ผลทดสอบกับไฟล์จริง 31 แถว: แกะประเภทลูกค้าได้ 31/31, ประเภทงานได้ 28/31, จำนวนคนได้ 30/31
(แถวที่แกะไม่ได้ เพราะตัวไฟล์เองไม่ได้ระบุโค้ดประเภทงาน/จำนวนคนไว้ ไม่ใช่ regex พลาด)

⚠️ ประเภทงานที่เจอจริงในไฟล์: MT, WD, DN, WL, Audition, EN
   "EN" ไม่อยู่ในลิสต์เดิม (MT, Audition, ED, WD, WL, DN) และไม่เจอ "ED" เลยในไฟล์ตัวอย่างนี้
   ควรถามทีมขายว่า EN คืออะไร (เช่น Engagement?) และ ED ใช้ในสถานการณ์ไหนก่อนสรุป schema สุดท้าย

⚠️ "เหตุผลยกเลิก" เป็นข้อความอิสระของพนักงานจริง ๆ ไม่ได้เลือกจาก dropdown คงที่
   สคริปต์นี้แยกข้อความเหตุผลออกมาให้ (raw_reason) แต่การจัดกลุ่มเป็นหมวดสำหรับกราฟ "เหตุผลยกเลิกเรียงมาก->น้อย"
   ต้องอาศัย categorize_reason() ด้านล่างซึ่งเป็น keyword-based heuristic เบื้องต้นเท่านั้น
   ควรให้ทีมขายช่วยตรวจ/ปรับ keyword ให้ตรงกับสิ่งที่มักเขียนจริง หรือพิจารณาเปลี่ยนไปใช้ dropdown เหตุผลคงที่ในระบบ
   ตั้งแต่ต้นทาง เพื่อให้ได้รายงานที่แม่นยำในระยะยาว
"""

import argparse
import json
import re
import sys
from pathlib import Path

import openpyxl
from openpyxl.utils import get_column_letter

# ---------------------------------------------------------------------------
# CONFIG — ปรับตรงนี้ถ้าโครงสร้างคอลัมน์เปลี่ยน
# ---------------------------------------------------------------------------
HEADER_ROW = 7
COL_QTN = "A"
COL_EVENT_NAME = "C"
COL_SALE = "N"
COL_STATUS = "Q"
CANCEL_STATUS_VALUES = {"Cancel"}

# ลำดับสำคัญ: โค้ดที่ยาว/เฉพาะเจาะจงกว่าควรมาก่อน เพื่อกันจับคู่ผิด (เช่น "Audition" ต้องมาก่อน "DN")
JOB_CODES = ["Audition", "MT", "WD", "DN", "WL", "EN", "ED"]

CUSTOMER_RE = re.compile(r"ลค\.?\s*-?\s*([ABCN])\b", re.IGNORECASE)
PAX_RE = re.compile(r"(\d+)(?:[-–](\d+))?\s*P\b", re.IGNORECASE)

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


def load_cancelled_rows(path: Path) -> list:
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
        rows.append(
            {
                "qtn": qtn,
                "sales": (by_col.get(COL_SALE) or "").strip() or None,
                "job_type": extracted["job_type"],
                "customer_type": extracted["customer_type"],
                "pax": extracted["pax"],
                "raw_reason": extracted["reason"],
                "reason_category": categorize_reason(extracted["reason"]),
            }
        )
    return rows


def aggregate(rows: list) -> dict:
    def count_by(key, transform=lambda x: x):
        counts = {}
        for r in rows:
            v = r.get(key)
            if v:
                v = transform(v)
                counts[v] = counts.get(v, 0) + 1
        return sorted(
            [{"name": k, "value": v} for k, v in counts.items()],
            key=lambda x: -x["value"],
        )

    reason_counts = {}
    for r in rows:
        reason_counts[r["reason_category"]] = reason_counts.get(r["reason_category"], 0) + 1
    reasons = sorted(
        [{"reason": k, "count": v} for k, v in reason_counts.items()],
        key=lambda x: -x["count"],
    )

    sales_counts = {}
    for r in rows:
        if r["sales"]:
            sales_counts[r["sales"]] = sales_counts.get(r["sales"], 0) + 1
    sales_ranking = sorted(
        [{"name": k, "count": v} for k, v in sales_counts.items()],
        key=lambda x: -x["count"],
    )

    return {
        "totalCancelledJobs": len(rows),
        "byCustomerType": count_by("customer_type", lambda v: f"ลค.{v}"),
        "byJobType": count_by("job_type"),
        "reasons": reasons,
        "salesRanking": sales_ranking,
        "unmatched": {
            "jobType": sum(1 for r in rows if not r["job_type"]),
            "customerType": sum(1 for r in rows if not r["customer_type"]),
            "pax": sum(1 for r in rows if not r["pax"]),
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Parse ไฟล์ Cancelled.xlsx เป็น JSON สำหรับ dashboard")
    parser.add_argument("input", type=str, help="ไฟล์ Cancelled (.xlsx)")
    parser.add_argument("--out", type=str, default=None)
    args = parser.parse_args()

    path = Path(args.input)
    if not path.exists():
        print(f"ไม่พบไฟล์: {path}", file=sys.stderr)
        sys.exit(1)

    rows = load_cancelled_rows(path)
    result = aggregate(rows)

    output_json = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(output_json, encoding="utf-8")
        print(f"บันทึกผลลัพธ์ {len(rows)} รายการที่ {args.out}")
    else:
        print(output_json)


if __name__ == "__main__":
    main()
