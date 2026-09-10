"""
ที่เก็บข้อมูลหลักของแอป — เก็บไว้ในหน่วยความจำระหว่างรัน แล้ว persist ลงไฟล์ JSON เดียว
(backend/data/store_state.json) ทุกครั้งที่ข้อมูลเปลี่ยน เพื่อให้รอดจากการรีสตาร์ท backend
เหมาะสำหรับ dev/demo เท่านั้น — ก่อนขึ้น production จริง (หลายเครื่อง/หลาย instance พร้อมกัน)
ควรย้ายไป database จริงแทนไฟล์เดียวนี้
"""

import json
import threading
import uuid
from datetime import date, datetime, timezone
from pathlib import Path

from . import config
from .parsing import raw_export
from .parsing.cancelled import load_cancelled_rows
from .parsing.calendar import extract_events


def _parse_cancelled_file(path: Path) -> list[dict]:
    if raw_export.is_raw_export_format(path):
        return raw_export.load_cancelled_rows(path)
    return load_cancelled_rows(path)


def _parse_calendar_file(path: Path, status: str) -> list[dict]:
    if raw_export.is_raw_export_format(path):
        # ไฟล์รูปแบบใหม่มีสถานะจริงต่อแถวอยู่แล้ว ไม่ต้องเดาจากพารามิเตอร์ status
        return raw_export.load_calendar_events(path)
    return extract_events(path, status=status)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def dedupe_cancelled(rows: list[dict]) -> list[dict]:
    """ตัดรายการซ้ำ — ถือว่าซ้ำกันถ้าเลข QN ตรงกัน (แถวที่ไม่มี QN เก็บไว้ทั้งหมด เทียบไม่ได้)"""
    seen: set[str] = set()
    out = []
    for r in rows:
        qtn = r.get("qtn")
        if qtn and qtn in seen:
            continue
        if qtn:
            seen.add(qtn)
        out.append(r)
    return out


def _to_jsonable(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        d = dict(r)
        for k, v in d.items():
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat()
        out.append(d)
    return out


def _parse_date_field(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def dedupe_calendar(events: list[dict]) -> list[dict]:
    """ตัดรายการซ้ำ — ถือว่าซ้ำกันถ้า id ตรงกัน (id คำนวณจาก วันที่+ชื่องาน+sales+pax ดู parsing/cancelled.py::make_event_id)"""
    seen: set[str] = set()
    out = []
    for e in events:
        eid = e.get("id")
        if eid and eid in seen:
            continue
        if eid:
            seen.add(eid)
        out.append(e)
    return out


class Store:
    def __init__(self):
        self.lock = threading.Lock()
        self.cancelled_rows: list[dict] = []
        self.calendar_events: list[dict] = []
        self.upload_history: list[dict] = []
        self.jobs: dict[str, dict] = {}
        self.drive_status = {"status": "synced", "lastSyncAt": now_iso()}
        # event id (จาก make_event_id) -> วันที่ออก Function Sheet (ISO date string) — ผู้ใช้กรอกเองผ่าน
        # POST /function-sheet/{event_id} คงอยู่ข้าม re-upload เพราะ id คำนวณจากข้อมูลงานเอง ไม่ใช่ index
        self.function_sheet_issued: dict[str, str] = {}
        # ตัวเลือกแบบ dropdown สำหรับฟอร์มกรอกงานด้วยมือ — แก้ไข/เพิ่มเองได้ผ่าน PUT /options/{list_name}
        # (แก้ที่นี่แค่เปลี่ยนตัวเลือกที่เลือกได้ทีหลัง ไม่กระทบข้อความที่บันทึกไปแล้วในงานเก่า)
        self.option_lists: dict[str, list[str]] = {
            "customerType": ["A", "B", "C", "N"],
            "jobType": ["MT", "WD", "DN", "WL", "Audition", "EN", "ED"],
            "sales": ["Pheeraphorn Chayarun", "Nicharee Nakkliang", "Lapatrada Duangjan", "Janjira Petna"],
        }
        # โหลดข้อมูลที่เคยบันทึกไว้ก่อนหน้า (ถ้ามี) แทนการ seed ใหม่ทุกครั้ง — ทำให้ข้อมูลที่อัพโหลด/
        # กรอกเองไม่หายตอน backend รีสตาร์ท (ดู _save/_load_persisted ด้านล่าง)
        if not self._load_persisted():
            self._seed()
            self._save()

    # -- persist ลงไฟล์ backend/data/store_state.json ทุกครั้งที่ข้อมูลเปลี่ยน --
    def _save(self):
        state = {
            "cancelledRows": _to_jsonable(self.cancelled_rows),
            "calendarEvents": _to_jsonable(self.calendar_events),
            "uploadHistory": self.upload_history,
            "functionSheetIssued": self.function_sheet_issued,
            "optionLists": self.option_lists,
        }
        tmp = config.STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        tmp.replace(config.STATE_FILE)

    def _load_persisted(self) -> bool:
        if not config.STATE_FILE.exists():
            return False
        try:
            state = json.loads(config.STATE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return False

        cancelled_rows = []
        for r in state.get("cancelledRows", []):
            r = dict(r)
            r["event_date"] = _parse_date_field(r.get("event_date"))
            if "contact_date" in r:
                r["contact_date"] = _parse_date_field(r.get("contact_date"))
            cancelled_rows.append(r)

        calendar_events = []
        for e in state.get("calendarEvents", []):
            e = dict(e)
            e["date_obj"] = _parse_date_field(e.get("date_obj"))
            if "contact_date" in e:
                e["contact_date"] = _parse_date_field(e.get("contact_date"))
            calendar_events.append(e)

        self.cancelled_rows = cancelled_rows
        self.calendar_events = calendar_events
        self.upload_history = state.get("uploadHistory", [])
        self.function_sheet_issued = state.get("functionSheetIssued", {})
        if state.get("optionLists"):
            self.option_lists = state["optionLists"]
        return True

    # -- seed จากไฟล์จริงที่มีอยู่แล้วในโปรเจกต์ ให้ dashboard มีข้อมูลให้ดูทันทีตั้งแต่แรก --
    def _seed(self):
        if config.SEED_CANCELLED_FILE.exists():
            self.cancelled_rows = dedupe_cancelled(_parse_cancelled_file(config.SEED_CANCELLED_FILE))
            self.upload_history.append({
                "id": "up_seed_cancelled",
                "fileName": config.SEED_CANCELLED_FILE.name,
                "type": "Cancelled",
                "uploadedBy": "ระบบ (seed)",
                "uploadedAt": now_iso(),
                "fileStatus": "ผ่าน",
                "driveStatus": "synced",
                "rows": len(self.cancelled_rows),
            })
        if config.SEED_CALENDAR_FILE.exists():
            self.calendar_events = dedupe_calendar(_parse_calendar_file(config.SEED_CALENDAR_FILE, status="Confirmed"))
            self.upload_history.append({
                "id": "up_seed_calendar",
                "fileName": config.SEED_CALENDAR_FILE.name,
                "type": "Calendar",
                "uploadedBy": "ระบบ (seed)",
                "uploadedAt": now_iso(),
                "fileStatus": "ผ่าน",
                "driveStatus": "synced",
                "rows": len(self.calendar_events),
            })

    # -- ingest ไฟล์ที่อัพโหลดเข้ามาจริง --
    def ingest_cancelled(self, path: Path):
        rows = dedupe_cancelled(_parse_cancelled_file(path))
        with self.lock:
            self.cancelled_rows = rows  # ไฟล์ Cancelled ใหม่แทนที่ชุดเดิมทั้งไฟล์ (export เต็มรอบเสมอ)
        self._save()
        return len(rows)

    def ingest_calendar(self, path: Path, status: str = "Confirmed"):
        events = dedupe_calendar(_parse_calendar_file(path, status=status))
        with self.lock:
            # แทนที่เฉพาะ event ของสถานะที่ปรากฏในไฟล์นี้ เพื่อรองรับการอัพโหลดหลายไฟล์แยกตามสถานะ
            # (ไฟล์รูปแบบเดิมมีสถานะเดียวทั้งไฟล์ตามพารามิเตอร์ status, ไฟล์รูปแบบใหม่มีสถานะจริงต่อแถว
            # จึงอาจมีได้มากกว่า 1 สถานะในไฟล์เดียว — ดู parsing/raw_export.py)
            statuses_in_file = {e["status"] for e in events} or {status}
            self.calendar_events = [e for e in self.calendar_events if e["status"] not in statuses_in_file] + events
        self._save()
        return len(events)

    def ingest_raw_export(self, path: Path) -> int:
        """
        ไฟล์รูปแบบใหม่ (ดู parsing/raw_export.py) มีทั้งแถว Cancelled และ Confirmed/Pending ปนกันได้ในไฟล์
        เดียว — ไม่ขึ้นกับว่าอัพโหลดเข้าช่อง "Cancelled" หรือ "Calendar" แยกฟิลด์ตามสถานะจริงในไฟล์เสมอ
        """
        cancelled_rows = dedupe_cancelled(raw_export.load_cancelled_rows(path))
        calendar_events = dedupe_calendar(raw_export.load_calendar_events(path))
        with self.lock:
            if cancelled_rows:
                self.cancelled_rows = cancelled_rows
            if calendar_events:
                statuses_in_file = {e["status"] for e in calendar_events}
                self.calendar_events = [e for e in self.calendar_events if e["status"] not in statuses_in_file] + calendar_events
        self._save()
        return len(cancelled_rows) + len(calendar_events)

    def add_manual_cancelled(self, row: dict):
        with self.lock:
            self.cancelled_rows.append(row)
        self._save()

    def add_manual_calendar(self, event: dict):
        with self.lock:
            self.calendar_events.append(event)
        self._save()

    def set_function_sheet_issued(self, event_id: str, issued_at: str | None):
        with self.lock:
            if issued_at:
                self.function_sheet_issued[event_id] = issued_at
            else:
                self.function_sheet_issued.pop(event_id, None)
        self._save()

    def add_upload_history(self, entry: dict):
        with self.lock:
            self.upload_history.insert(0, entry)
        self._save()

    def create_job(self, files: list[dict]) -> str:
        job_id = f"job_{uuid.uuid4().hex[:8]}"
        with self.lock:
            self.jobs[job_id] = {
                "jobId": job_id,
                "status": "processing",
                "stage": "uploading",
                "progress": 5,
                "error": None,
                "files": files,
            }
        return job_id

    def update_job(self, job_id: str, **fields):
        with self.lock:
            if job_id in self.jobs:
                self.jobs[job_id].update(fields)

    def get_job(self, job_id: str):
        return self.jobs.get(job_id)

    def set_option_list(self, list_name: str, values: list[str]):
        with self.lock:
            self.option_lists[list_name] = values
        self._save()

    def reset_to_seed(self):
        """เครื่องมือผู้ดูแลระบบ: ล้างข้อมูลทดสอบทั้งหมด (ไฟล์ที่อัปโหลด, งานที่กรอกเอง, สถานะ Function
        Sheet, jobs) กลับไปเป็นแค่ไฟล์ seed ดั้งเดิม — เหมือนรีสตาร์ท backend แต่ไม่ต้องรีสตาร์ทจริง"""
        with self.lock:
            self.cancelled_rows = []
            self.calendar_events = []
            self.upload_history = []
            self.jobs = {}
            self.function_sheet_issued = {}
            self.drive_status = {"status": "synced", "lastSyncAt": now_iso()}
        self._seed()
        self._save()

    def export_snapshot(self) -> dict:
        """เครื่องมือผู้ดูแลระบบ: export ข้อมูลดิบทั้งหมดในระบบตอนนี้เป็น JSON (โหลดเก็บไว้ก่อนรีเซ็ตได้)"""
        def _jsonable(rows):
            out = []
            for r in rows:
                d = dict(r)
                for k, v in d.items():
                    if hasattr(v, "isoformat"):
                        d[k] = v.isoformat()
                out.append(d)
            return out

        return {
            "exportedAt": now_iso(),
            "cancelledRows": _jsonable(self.cancelled_rows),
            "calendarEvents": _jsonable(self.calendar_events),
            "uploadHistory": self.upload_history,
            "functionSheetIssued": self.function_sheet_issued,
        }


store = Store()
