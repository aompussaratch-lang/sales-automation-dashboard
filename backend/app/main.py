"""
FastAPI backend สำหรับระบบสรุปข้อมูลฝ่ายขายอัตโนมัติ — endpoint ทั้งหมดตาม api_schema.md
ตรรกะแกะไฟล์หลักอยู่ใน app/parsing/ (ดัดแปลงจาก parse_cancelled.py และ parse_calendar_excel.py เดิม)
รัน: uvicorn app.main:app --reload --port 8000   (จากในโฟลเดอร์ backend/)
"""

import io
import json
import time
import uuid
from datetime import date

from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import aggregate, config
from .auth import get_current_user, require_roles
from .parsing import raw_export
from .parsing.cancelled import categorize_reason, make_event_id
from .store import now_iso, store

app = FastAPI(title="Sales Automation API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def date_range(from_: str | None, to_: str | None) -> tuple[date, date]:
    d_from = aggregate.parse_date_param(from_, date(2000, 1, 1))
    d_to = aggregate.parse_date_param(to_, date(2100, 1, 1))
    if d_from > d_to:
        raise HTTPException(status_code=400, detail="'from' ต้องไม่มากกว่า 'to'")
    return d_from, d_to


# ---------------------------------------------------------------------------
# 1. Authentication
# ---------------------------------------------------------------------------
@app.get("/auth/me")
def auth_me(user: dict = Depends(get_current_user)):
    return user


# ---------------------------------------------------------------------------
# 2. อัพโหลดไฟล์
# ---------------------------------------------------------------------------
def _classify_filename(filename: str) -> str:
    name = filename.lower()
    if "cancel" in name:
        return "cancelled"
    if "calendar" in name or "function" in name:
        return "calendar"
    if name.endswith((".xlsx", ".xls", ".csv")):
        return "cancelled"
    return "calendar"


def _process_upload_job(job_id: str, saved_files: list[dict]):
    store.update_job(job_id, stage="uploading", progress=15)
    time.sleep(0.3)

    store.update_job(job_id, stage="parsing", progress=40)
    errors = []
    for f in saved_files:
        try:
            if raw_export.is_raw_export_format(f["path"]):
                # ไฟล์รูปแบบใหม่ (คอลัมน์ วัน/Status/Cust Type/.../Pax) แยกแถว Cancelled/Confirmed
                # ตามสถานะจริงในไฟล์เอง ไม่ต้องพึ่งการเดา type จากชื่อไฟล์ (ดู parsing/raw_export.py)
                n = store.ingest_raw_export(f["path"])
            elif f["type"] == "cancelled":
                n = store.ingest_cancelled(f["path"])
            else:
                n = store.ingest_calendar(f["path"], status="Confirmed")
            file_status = "ผ่าน"
        except Exception as exc:  # ไฟล์รูปแบบไม่ตรงที่คาด (คอลัมน์/หัวตารางเปลี่ยน)
            n = 0
            file_status = "ไม่ผ่าน"
            errors.append(f"{f['fileName']}: {exc}")
        store.add_upload_history({
            "id": f"up_{job_id}_{f['fileName']}",
            "fileName": f["fileName"], "type": "Cancelled" if f["type"] == "cancelled" else "Calendar",
            "uploadedBy": f["uploadedBy"], "uploadedAt": now_iso(),
            "fileStatus": file_status, "driveStatus": "syncing" if file_status == "ผ่าน" else "failed", "rows": n,
        })

    store.update_job(job_id, stage="syncing_drive", progress=85)
    store.drive_status = {"status": "syncing", "lastSyncAt": store.drive_status["lastSyncAt"]}
    time.sleep(0.3)

    synced_at = now_iso()
    for h in store.upload_history:
        if h["id"].startswith(f"up_{job_id}_") and h["driveStatus"] == "syncing":
            h["driveStatus"] = "synced"
    store.drive_status = {"status": "synced", "lastSyncAt": synced_at}

    if errors:
        store.update_job(job_id, status="failed", stage="syncing_drive", progress=100, error="; ".join(errors))
    else:
        store.update_job(job_id, status="done", stage="syncing_drive", progress=100)


@app.post("/uploads", status_code=202)
async def upload_files(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    user: dict = Depends(require_roles("sales")),
):
    if not files:
        raise HTTPException(status_code=400, detail="ต้องแนบไฟล์อย่างน้อย 1 ไฟล์ ในฟิลด์ files[]")

    saved_files = []
    response_files = []
    for uf in files:
        file_type = _classify_filename(uf.filename)
        dest = config.UPLOAD_DIR / f"{int(time.time()*1000)}_{uf.filename}"
        content = await uf.read()
        dest.write_bytes(content)
        saved_files.append({"path": dest, "fileName": uf.filename, "type": file_type, "uploadedBy": user["name"]})
        response_files.append({"fileName": uf.filename, "type": file_type})

    job_id = store.create_job(response_files)
    background_tasks.add_task(_process_upload_job, job_id, saved_files)

    return {"jobId": job_id, "status": "processing", "files": response_files}


@app.get("/uploads/{job_id}/status")
def upload_status(job_id: str, user: dict = Depends(get_current_user)):
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="ไม่พบ job นี้")
    return job


@app.get("/uploads/history")
def upload_history(user: dict = Depends(require_roles("sales"))):
    return {"items": store.upload_history}


class ManualEntry(BaseModel):
    """
    ทางเลือกกรอกงานทีละรายการด้วยมือ (แทนอัปโหลดไฟล์) — ไม่ได้แทนที่ไฟล์อัปโหลด แค่ "เพิ่ม" งานใหม่
    เข้าไปในชุดข้อมูลปัจจุบัน (ไฟล์อัปโหลดจริงยังคงแทนที่ข้อมูลทั้งไฟล์ตามปกติ)
    """
    status: str  # "Cancelled" หรือ "Confirmed"
    date: str  # YYYY-MM-DD — วันที่จัดงาน
    contactDate: str | None = None  # YYYY-MM-DD — วันที่ติดต่อ/ทำใบเสนอราคา (ไม่บังคับ)
    customerName: str | None = None
    customerType: str | None = None  # A/B/C/N (เฉพาะ Cancelled)
    jobType: str | None = None
    timeOfDay: str | None = None  # ช่วงเช้า/บ่าย/เย็น
    pax: int | None = None
    sales: str | None = None
    reason: str | None = None  # เฉพาะ Cancelled
    location: str | None = None  # เฉพาะ Confirmed (ห้อง)


@app.post("/manual-entry", status_code=201)
def manual_entry(body: ManualEntry, user: dict = Depends(require_roles("sales"))):
    try:
        event_date = date.fromisoformat(body.date)
    except ValueError:
        raise HTTPException(status_code=400, detail="date ต้องเป็นรูปแบบ YYYY-MM-DD")

    contact_date = None
    if body.contactDate:
        try:
            contact_date = date.fromisoformat(body.contactDate)
        except ValueError:
            raise HTTPException(status_code=400, detail="contactDate ต้องเป็นรูปแบบ YYYY-MM-DD")

    if body.status == "Cancelled":
        row = {
            "qtn": f"MANUAL-{uuid.uuid4().hex[:8]}",
            "event_date": event_date,
            "contact_date": contact_date,
            "customer_name": body.customerName,
            "sales": body.sales,
            "job_type": body.jobType or None,
            "customer_type": body.customerType or None,
            "time_of_day": body.timeOfDay or None,
            "pax": body.pax,
            "raw_reason": body.reason or "",
            "reason_category": categorize_reason(body.reason or ""),
        }
        store.add_manual_cancelled(row)
        return {"status": "ok", "type": "cancelled", "qtn": row["qtn"]}

    title = body.customerName or "(ไม่มีชื่องาน)"
    event = {
        "id": make_event_id(event_date, title, body.sales, body.pax),
        "date": event_date.isoformat(),
        "date_obj": event_date,
        "contact_date": contact_date,
        "start": None,
        "end": None,
        "time_of_day": body.timeOfDay or None,
        "pax": body.pax or 0,
        "sales": body.sales,
        "title": title,
        "location": body.location or None,
        "job_type": body.jobType or None,
        "status": "Confirmed",
    }
    store.add_manual_calendar(event)
    return {"status": "ok", "type": "confirmed", "id": event["id"]}


@app.get("/options")
def get_options(user: dict = Depends(get_current_user)):
    return store.option_lists


@app.put("/options/{list_name}")
def update_options(list_name: str, body: list[str], user: dict = Depends(get_current_user)):
    if list_name not in store.option_lists:
        raise HTTPException(status_code=404, detail=f"ไม่พบรายการตัวเลือกชื่อ '{list_name}'")
    cleaned = [v.strip() for v in body if v.strip()]
    store.set_option_list(list_name, cleaned)
    return {list_name: cleaned}


# ---------------------------------------------------------------------------
# เครื่องมือผู้ดูแลระบบ — เฉพาะ role manager (บังคับสิทธิ์ฝั่ง backend จริง ไม่ใช่แค่ซ่อนปุ่ม)
# ---------------------------------------------------------------------------
@app.get("/admin/export")
def admin_export(user: dict = Depends(require_roles("manager"))):
    snapshot = store.export_snapshot()
    data = json.dumps(snapshot, ensure_ascii=False, indent=2).encode("utf-8")
    filename = f"sales_data_snapshot_{date.today().isoformat()}.json"
    return StreamingResponse(
        io.BytesIO(data), media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/admin/reset")
def admin_reset(user: dict = Depends(require_roles("manager"))):
    store.reset_to_seed()
    return {
        "status": "ok",
        "cancelledRows": len(store.cancelled_rows),
        "calendarEvents": len(store.calendar_events),
    }


# ---------------------------------------------------------------------------
# 3. Google Drive sync
# ---------------------------------------------------------------------------
@app.get("/drive/status")
def drive_status(user: dict = Depends(get_current_user)):
    return store.drive_status


# ---------------------------------------------------------------------------
# 4. ข้อมูลสรุป (Dashboard)
# ---------------------------------------------------------------------------
@app.get("/summary/kpi")
def summary_kpi(from_: str | None = Query(None, alias="from"), to: str | None = None, user: dict = Depends(require_roles("sales", "manager", "executive"))):
    d_from, d_to = date_range(from_, to)
    prev_from, prev_to = aggregate.previous_period(d_from, d_to)

    cancelled_cur = aggregate.filter_cancelled(store.cancelled_rows, d_from, d_to)
    cancelled_prev = aggregate.filter_cancelled(store.cancelled_rows, prev_from, prev_to)
    confirmed_cur = aggregate.filter_calendar(store.calendar_events, d_from, d_to, status="Confirmed")
    confirmed_prev = aggregate.filter_calendar(store.calendar_events, prev_from, prev_to, status="Confirmed")

    return aggregate.compute_kpi(cancelled_cur, cancelled_prev, confirmed_cur, confirmed_prev)


@app.get("/summary/cancellations")
def summary_cancellations(from_: str | None = Query(None, alias="from"), to: str | None = None, user: dict = Depends(require_roles("sales", "manager", "executive"))):
    d_from, d_to = date_range(from_, to)
    rows = aggregate.filter_cancelled(store.cancelled_rows, d_from, d_to)
    return aggregate.compute_cancellations(rows)


@app.get("/summary/job-status")
def summary_job_status(from_: str | None = Query(None, alias="from"), to: str | None = None, user: dict = Depends(require_roles("sales", "manager", "executive"))):
    d_from, d_to = date_range(from_, to)
    cancelled_rows = aggregate.filter_cancelled(store.cancelled_rows, d_from, d_to)
    calendar_events = aggregate.filter_calendar(store.calendar_events, d_from, d_to)
    return aggregate.compute_job_status(cancelled_rows, calendar_events)


@app.get("/summary/pax-bins")
def summary_pax_bins(from_: str | None = Query(None, alias="from"), to: str | None = None, user: dict = Depends(require_roles("sales", "manager", "executive"))):
    d_from, d_to = date_range(from_, to)
    confirmed = aggregate.filter_calendar(store.calendar_events, d_from, d_to, status="Confirmed")
    return aggregate.compute_pax_bins(confirmed)


@app.get("/summary/manpower-calendar")
def summary_manpower_calendar(from_: str | None = Query(None, alias="from"), to: str | None = None, user: dict = Depends(require_roles("sales", "manager", "executive"))):
    d_from, d_to = date_range(from_, to)
    confirmed = aggregate.filter_calendar(store.calendar_events, d_from, d_to, status="Confirmed")
    return aggregate.compute_manpower_calendar(confirmed, d_from, d_to)


@app.get("/summary/confirmed-stats")
def summary_confirmed_stats(from_: str | None = Query(None, alias="from"), to: str | None = None, user: dict = Depends(require_roles("sales", "manager", "executive"))):
    d_from, d_to = date_range(from_, to)
    confirmed = aggregate.filter_calendar(store.calendar_events, d_from, d_to, status="Confirmed")
    return aggregate.compute_confirmed_stats(confirmed)


@app.get("/summary/data-quality")
def summary_data_quality(user: dict = Depends(require_roles("sales", "manager", "executive"))):
    return aggregate.compute_data_quality(store.cancelled_rows, store.calendar_events)


# ---------------------------------------------------------------------------
# Function Sheet — เอกสารระบุรายละเอียดงานที่ต้องออกให้ฝ่ายปฏิบัติการก่อนวันงานอย่างน้อย 14 วัน
# ---------------------------------------------------------------------------
@app.get("/function-sheet")
def function_sheet_list(from_: str | None = Query(None, alias="from"), to: str | None = None, user: dict = Depends(require_roles("sales", "manager", "executive"))):
    d_from, d_to = date_range(from_, to)
    confirmed = aggregate.filter_calendar(store.calendar_events, d_from, d_to, status="Confirmed")
    return aggregate.compute_function_sheet(confirmed, store.function_sheet_issued, date.today())


class FunctionSheetUpdate(BaseModel):
    issuedAt: str | None = None  # ISO date string, หรือ None เพื่อล้างค่า (ยังไม่ออก)


@app.post("/function-sheet/{event_id}")
def function_sheet_update(event_id: str, body: FunctionSheetUpdate, user: dict = Depends(require_roles("sales", "manager", "executive"))):
    if body.issuedAt:
        try:
            date.fromisoformat(body.issuedAt)
        except ValueError:
            raise HTTPException(status_code=400, detail="issuedAt ต้องเป็นวันที่รูปแบบ YYYY-MM-DD")
    store.set_function_sheet_issued(event_id, body.issuedAt)
    return {"id": event_id, "issuedAt": body.issuedAt}


# ---------------------------------------------------------------------------
# 5. ดาวน์โหลดรายงาน
# ---------------------------------------------------------------------------
@app.get("/reports/export")
def reports_export(
    format: str = Query(..., pattern="^(pdf|csv)$"),
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    user: dict = Depends(require_roles("sales", "manager", "executive")),
):
    d_from, d_to = date_range(from_, to)
    cancelled_rows = aggregate.filter_cancelled(store.cancelled_rows, d_from, d_to)
    events_payload = aggregate.compute_events(cancelled_rows, [], {})["items"]
    filename = f"sales_summary_{d_from.isoformat()}_{d_to.isoformat()}.{format}"

    if format == "csv":
        import csv
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=["eventName", "date", "customerType", "jobType", "status", "reason", "sales", "pax"])
        writer.writeheader()
        writer.writerows(events_payload)
        data = buf.getvalue().encode("utf-8-sig")  # BOM ให้ Excel ไทยเปิดแล้วไม่เป็นอักขระเพี้ยน
        return StreamingResponse(
            io.BytesIO(data), media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # format == "pdf"
    from fpdf import FPDF

    kpi = aggregate.compute_kpi(
        cancelled_rows, [],
        aggregate.filter_calendar(store.calendar_events, d_from, d_to, status="Confirmed"), [],
    )
    cancellations = aggregate.compute_cancellations(cancelled_rows)

    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, "Sales Summary Report", ln=True)
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(0, 8, f"Period: {d_from.isoformat()} - {d_to.isoformat()}", ln=True)
    pdf.ln(4)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "KPI", ln=True)
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(0, 7, f"Cancelled jobs: {kpi['cancelledJobs']['current']}", ln=True)
    pdf.cell(0, 7, f"Cancelled pax: {kpi['cancelledCustomers']['current']}", ln=True)
    pdf.cell(0, 7, f"Confirmed total: {kpi['confirmedTotal']['current']}", ln=True)
    pdf.ln(4)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Top cancel reasons", ln=True)
    pdf.set_font("Helvetica", "", 11)
    for r in cancellations["reasons"][:10]:
        pdf.cell(0, 7, f"- {r['reason']}: {r['count']}", ln=True)

    data = bytes(pdf.output())
    return StreamingResponse(
        io.BytesIO(data), media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# 6. รายละเอียดเจาะจง (drill-down)
# ---------------------------------------------------------------------------
@app.get("/events")
def events(
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    customerType: str | None = None,
    jobType: str | None = None,
    status: str | None = None,
    paxMin: int | None = None,
    paxMax: int | None = None,
    user: dict = Depends(require_roles("sales", "manager", "executive")),
):
    filters = {
        "from": from_, "to": to, "customerType": customerType, "jobType": jobType,
        "status": status, "paxMin": paxMin, "paxMax": paxMax,
    }
    return aggregate.compute_events(store.cancelled_rows, store.calendar_events, filters)
