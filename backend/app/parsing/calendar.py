"""
Parser สำหรับไฟล์ Function Calendar (.xlsx) — ดัดแปลงจาก parse_calendar_excel.py เดิม (root ของโปรเจกต์)
คง logic การแกะตารางปฏิทินรายสัปดาห์ไว้ทั้งหมด (หา header "Mon", วันที่ใต้แถว header, แล้วแกะข้อความ
ในแต่ละเซลล์ด้วย EVENT_RE) เพียงแค่:
  - คืน date เป็น `date` object เพิ่มให้ (นอกจาก date_str เดิม) เพื่อใช้กรองช่วงวันที่ from/to
  - เดา job_type จากข้อความ title ด้วย find_job_type ตัวเดียวกับ parse_cancelled.py — ไฟล์ปฏิทินจริง
    ไม่มีคอลัมน์ประเภทงานแยก แต่โค้ดงาน (MT/WD/...) มักปรากฏในข้อความ title เช่นเดียวกับที่พบใน
    Cancelled.xlsx ⚠️ นี่คือ heuristic เพิ่มเติมที่ไม่ได้อยู่ในสคริปต์ต้นฉบับ — ควรให้ทีมขายช่วยตรวจ
    ว่าตรงกับของจริงแค่ไหน ก่อนใช้กราฟ "ประเภทงาน × สถานะ" (/summary/job-status) ตัดสินใจอะไรสำคัญ

ไฟล์ export จริงกรองสถานะไว้แล้วตั้งแต่ต้นทาง (ไม่ได้เข้ารหัสด้วยสีเซลล์ตามที่สเปกเดิมคาดไว้) จึงต้องรับ
สถานะของไฟล์ผ่านพารามิเตอร์ `status` ตอนเรียก (ค่าเริ่มต้น "Confirmed" ตรงกับไฟล์ตัวอย่างที่ทดสอบแล้ว)
"""

import re
from datetime import date, datetime
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

from .cancelled import JOB_CODES, find_job_type, make_event_id  # noqa: F401 (reuse เดียวกับ Cancelled.xlsx)

EVENT_RE = re.compile(
    r"(?P<title>.*?)\((?P<start>\d{1,2}:\d{2})\s*-\s*(?P<end>\d{1,2}:\d{2})\)(?P<pax>[\d,]+)\s*Pax\s*/(?P<sales>[^\-]+?)(?=\s*-\s*[^\d]|$)",
    re.DOTALL,
)
DATE_HEADER_RE = re.compile(r"^\d{1,2}-[A-Za-z]{3}-\d{2}$")

TIME_SLOTS = ["ช่วงเช้า", "ช่วงบ่าย", "ช่วงเย็น"]


def time_of_day(start: str) -> str:
    hour = int(start.split(":")[0])
    if hour < 12:
        return TIME_SLOTS[0]
    if hour < 17:
        return TIME_SLOTS[1]
    return TIME_SLOTS[2]


def parse_cell_events(text: str, date_str: str, date_obj: date, status: str) -> list[dict]:
    text = text.replace("\r", "")
    events = []
    chunks = re.split(r"\n\s*-\s*\n?", text)
    for chunk in chunks:
        m = EVENT_RE.search(chunk)
        if not m:
            continue
        pax = int(m.group("pax").replace(",", ""))
        title = re.sub(r"\s+", " ", m.group("title")).strip(" \n/")
        sales = re.sub(r"\s+", " ", m.group("sales")).strip()
        job_type, _ = find_job_type(title)
        events.append(
            {
                "id": make_event_id(date_obj, title, sales, pax),
                "date": date_str,
                "date_obj": date_obj,
                "start": m.group("start"),
                "end": m.group("end"),
                "time_of_day": time_of_day(m.group("start")),
                "pax": pax,
                "sales": sales or None,
                "title": title,
                "location": None,  # ไฟล์รูปแบบเดิมไม่มีคอลัมน์ห้อง
                "job_type": job_type,
                "status": status,
            }
        )
    return events


def _parse_date_header(value: str) -> date | None:
    try:
        return datetime.strptime(value, "%d-%b-%y").date()
    except ValueError:
        return None


def extract_events(path: Path, status: str) -> list[dict]:
    wb = load_workbook(path, data_only=True)
    ws = wb[wb.sheetnames[0]]

    all_events = []
    # หา header rows จากคอลัมน์ A ที่มีค่า "Mon" (จุดเริ่มของแต่ละบล็อกสัปดาห์)
    header_rows = [c.row for c in ws["A"] if c.value == "Mon"]

    for header_row in header_rows:
        date_row = header_row + 1
        date_cols = {}
        for cell in ws[date_row]:
            if cell.value and DATE_HEADER_RE.match(str(cell.value)):
                d = _parse_date_header(str(cell.value))
                if d:
                    date_cols[get_column_letter(cell.column)] = (str(cell.value), d)
        if not date_cols:
            continue

        r = date_row + 1
        while r <= ws.max_row and ws.cell(row=r, column=1).value != "Mon":
            for col_letter, (date_str, date_obj) in date_cols.items():
                val = ws[f"{col_letter}{r}"].value
                if val:
                    all_events.extend(parse_cell_events(str(val), date_str, date_obj, status))
            r += 1

    return all_events


def bin_pax(pax: int) -> str:
    if pax < 150:
        return "<150 คน"
    if pax <= 300:
        return "150-300 คน"
    if pax <= 500:
        return "301-500 คน"
    return ">500 คน"
