"""
คำนวณ aggregate ทั้งหมดสำหรับ endpoint หมวด "ข้อมูลสรุป" (api_schema.md หัวข้อ 4) และหัวข้อ 6 (drill-down)
ฝั่ง backend เป็นคนคำนวณตัวเลขทั้งหมด ตามหมายเหตุท้าย api_schema.md — frontend มีหน้าที่แค่แสดงผล

⚠️ นิยาม "previous period" (ใช้ขับ trend badge ใน /summary/kpi): api_schema.md บอกไว้ว่ามีได้หลายแบบ
   และควรตกลงกับผู้ใช้งานจริงก่อน — ที่นี่เลือกใช้ "ช่วงเวลาที่มีความยาวเท่ากัน ต่อเนื่องก่อนหน้า from ทันที"
   (เช่น from=2026-08-01 to=2026-08-31 (31 วัน) -> previous = 2026-07-01..2026-07-31)
"""

from datetime import date, timedelta

from .parsing.cancelled import categorize_reason  # noqa: F401 (เผื่อ route อื่นอยาก reuse)
from .parsing.calendar import bin_pax


def parse_date_param(value: str | None, default: date) -> date:
    if not value:
        return default
    return date.fromisoformat(value)


def previous_period(date_from: date, date_to: date) -> tuple[date, date]:
    length = (date_to - date_from).days + 1
    prev_to = date_from - timedelta(days=1)
    prev_from = prev_to - timedelta(days=length - 1)
    return prev_from, prev_to


def _in_range(d: date | None, date_from: date, date_to: date) -> bool:
    return d is not None and date_from <= d <= date_to


def filter_cancelled(rows: list[dict], date_from: date, date_to: date) -> list[dict]:
    return [r for r in rows if _in_range(r["event_date"], date_from, date_to)]


def filter_calendar(events: list[dict], date_from: date, date_to: date, status: str | None = None) -> list[dict]:
    return [
        e for e in events
        if _in_range(e["date_obj"], date_from, date_to) and (status is None or e["status"] == status)
    ]


def _count_by(rows: list[dict], key: str, transform=lambda x: x) -> list[dict]:
    counts: dict[str, int] = {}
    for r in rows:
        v = r.get(key)
        if v:
            v = transform(v)
            counts[v] = counts.get(v, 0) + 1
    return sorted([{"name": k, "value": v} for k, v in counts.items()], key=lambda x: -x["value"])


def compute_cancellations(rows: list[dict]) -> dict:
    reason_counts: dict[str, int] = {}
    for r in rows:
        reason_counts[r["reason_category"]] = reason_counts.get(r["reason_category"], 0) + 1
    reasons = sorted(
        [{"reason": k, "count": v} for k, v in reason_counts.items()],
        key=lambda x: -x["count"],
    )

    sales_counts: dict[str, int] = {}
    for r in rows:
        if r["sales"]:
            sales_counts[r["sales"]] = sales_counts.get(r["sales"], 0) + 1
    sales_ranking = sorted(
        [{"name": k, "count": v} for k, v in sales_counts.items()],
        key=lambda x: -x["count"],
    )

    return {
        "byCustomerType": _count_by(rows, "customer_type", lambda v: f"ลค.{v}"),
        "byJobType": _count_by(rows, "job_type"),
        "reasons": reasons,
        "salesRanking": sales_ranking,
    }


def compute_kpi(cancelled_current: list[dict], cancelled_previous: list[dict], confirmed_current: list[dict], confirmed_previous: list[dict]) -> dict:
    cancellations = compute_cancellations(cancelled_current)
    top_reason = cancellations["reasons"][0] if cancellations["reasons"] else {"reason": None, "count": 0}
    cancelled_pax_current = sum(r["pax"] or 0 for r in cancelled_current)
    cancelled_pax_previous = sum(r["pax"] or 0 for r in cancelled_previous)

    return {
        "cancelledJobs": {"current": len(cancelled_current), "previous": len(cancelled_previous)},
        # "cancelledCustomers" = จำนวนคน (pax) รวมของงานที่ถูกยกเลิก ไม่ใช่จำนวน distinct ลูกค้า
        # (ตามที่ frontend เดิมคอมเมนต์ไว้ที่ totalCancelledCustomers)
        "cancelledCustomers": {"current": cancelled_pax_current, "previous": cancelled_pax_previous},
        "confirmedTotal": {"current": len(confirmed_current), "previous": len(confirmed_previous)},
        "topCancelReason": {"reason": top_reason["reason"], "count": top_reason["count"]},
    }


def compute_job_status(cancelled_rows: list[dict], calendar_events_in_range: list[dict]) -> dict:
    """
    "cancelled" มาจาก Cancelled.xlsx เสมอ (แหล่งเดียวกับ /summary/kpi -> cancelledJobs) เพื่อไม่ให้นับซ้ำ
    กับ event สถานะ "Cancelled" ที่อาจมาจากไฟล์ปฏิทิน — "confirmed"/"pending" มาจากไฟล์ปฏิทินตามสถานะจริง
    (ไฟล์ที่มีในระบบตอนนี้มีแค่สถานะ Confirmed ต้อง export เพิ่ม Not Confirm/Cut off เพื่อให้ pending มีค่า)
    """
    job_types: dict[str, dict] = {}

    def bucket(job_type):
        name = job_type or "ไม่ระบุ"
        return job_types.setdefault(name, {"name": name, "confirmed": 0, "pending": 0, "cancelled": 0})

    for e in calendar_events_in_range:
        if e["status"] == "Confirmed":
            bucket(e["job_type"])["confirmed"] += 1
        elif e["status"] != "Cancelled":
            bucket(e["job_type"])["pending"] += 1
    for r in cancelled_rows:
        bucket(r["job_type"])["cancelled"] += 1

    data = sorted(job_types.values(), key=lambda x: -(x["confirmed"] + x["pending"] + x["cancelled"]))
    return {"data": data}


def compute_pax_bins(confirmed_events: list[dict]) -> dict:
    bin_order = ["<150 คน", "150-300 คน", "301-500 คน", ">500 คน"]
    counts = {b: 0 for b in bin_order}
    for e in confirmed_events:
        counts[bin_pax(e["pax"])] += 1
    return {"bins": [{"name": b, "value": counts[b]} for b in bin_order]}


def compute_manpower_calendar(confirmed_events: list[dict], date_from: date, date_to: date) -> dict:
    by_day: dict[date, list[dict]] = {}
    for e in confirmed_events:
        by_day.setdefault(e["date_obj"], []).append(e)

    days = []
    cursor = date_from
    while cursor <= date_to:
        jobs = by_day.get(cursor, [])
        if jobs:
            days.append({
                "date": cursor.isoformat(),
                "count": len(jobs),
                "totalPax": sum(j["pax"] for j in jobs),
                "jobs": [
                    {"type": j["job_type"] or "อื่นๆ", "room": j.get("location") or "-", "pax": j["pax"], "time": j["time_of_day"]}
                    for j in jobs
                ],
            })
        cursor += timedelta(days=1)
    return {"days": days}


def compute_confirmed_stats(confirmed_events: list[dict]) -> dict:
    """แจกแจงงาน Confirmed ตาม Sales และตามห้อง (location) — สองมิติที่มีข้อมูลจริงครบ ต่างจาก
    ประเภทลูกค้า/ประเภทงานที่งาน Confirmed ส่วนใหญ่ไม่มีข้อมูล (ขึ้น "ไม่ระบุ" เกือบหมด)"""
    return {
        "bySales": _count_by(confirmed_events, "sales"),
        "byRoom": _count_by(confirmed_events, "location", lambda v: v or "ไม่ระบุ"),
    }


FUNCTION_SHEET_LEAD_DAYS = 14


def compute_function_sheet(confirmed_events: list[dict], issued_map: dict[str, str], today: date) -> dict:
    """
    สถานะการออก Function Sheet ต่องาน Confirmed — กฎ: ต้องออกก่อนวันจัดงานอย่างน้อย
    FUNCTION_SHEET_LEAD_DAYS วัน ถ้ายังไม่ออกและเหลือน้อยกว่ากำหนด ถือว่า "ใกล้ครบกำหนด/เลยกำหนด"
    """
    items = []
    not_issued_count = 0
    urgent_count = 0

    for e in confirmed_events:
        event_date = e["date_obj"]
        issued_at = issued_map.get(e["id"])
        days_until = (event_date - today).days if event_date else None

        if issued_at:
            status = "issued"
        elif days_until is not None and days_until <= FUNCTION_SHEET_LEAD_DAYS:
            status = "urgent"
        else:
            status = "not_due"

        if status != "issued":
            not_issued_count += 1
        if status == "urgent":
            urgent_count += 1

        items.append({
            "id": e["id"],
            "title": e["title"],
            "date": e["date_obj"].isoformat() if e["date_obj"] else None,
            "daysUntilEvent": days_until,
            "sales": e["sales"],
            "pax": e["pax"],
            "issuedAt": issued_at,
            "status": status,
        })

    items.sort(key=lambda it: (it["date"] or ""))
    return {
        "items": items,
        "notIssuedCount": not_issued_count,
        "urgentCount": urgent_count,
    }


def compute_data_quality(cancelled_rows: list[dict], calendar_events: list[dict]) -> dict:
    """
    "อ่านสำเร็จ" = แถวที่มีข้อมูลสำคัญครบ — งานยกเลิก: มี job_type, customer_type, pax ครบ
    (สามข้อนี้แกะจากข้อความอิสระ จึงมีโอกาสแกะไม่ได้) — งาน Confirmed: มี pax (คอลัมน์ตรงอยู่แล้ว
    แทบไม่มีโอกาสขาด, ที่เหลือเช่น job_type ยังไม่มี mapping จริงจึงไม่นับเป็น "ไม่สมบูรณ์")
    """
    total = len(cancelled_rows) + len(calendar_events)
    incomplete = 0
    for r in cancelled_rows:
        if not r["job_type"] or not r["customer_type"] or not r["pax"]:
            incomplete += 1
    for e in calendar_events:
        if not e["pax"]:
            incomplete += 1

    success = total - incomplete
    pct = round(incomplete / total * 100, 1) if total else 0.0
    success_pct = round(success / total * 100, 1) if total else 0.0
    return {
        "totalRead": total,
        "successRead": success,
        "successPct": success_pct,
        "incomplete": incomplete,
        "incompletePct": pct,
    }


def compute_events(cancelled_rows: list[dict], calendar_events: list[dict], filters: dict) -> dict:
    items = []

    for r in cancelled_rows:
        items.append({
            "eventName": r["customer_name"] or (r["raw_reason"][:40] if r["raw_reason"] else r["qtn"]),
            "date": r["event_date"].isoformat() if r["event_date"] else None,
            "customerType": r["customer_type"],
            "jobType": r["job_type"],
            "status": "cancelled",
            "reason": r["raw_reason"] or None,
            "sales": r["sales"],
            "pax": r["pax"],
        })

    for e in calendar_events:
        # ใช้ 3 ค่าเดียวกับ /summary/job-status เสมอ (confirmed/pending/cancelled) เพื่อให้ filter
        # status=... จากกราฟ "ประเภทงาน × สถานะ" ใช้ query กับ /events ตัวนี้ได้ตรงกัน
        if e["status"] == "Confirmed":
            status = "confirmed"
        elif e["status"] == "Cancelled":
            status = "cancelled"
        else:
            status = "pending"
        items.append({
            "eventName": e["title"],
            "date": e["date_obj"].isoformat() if e["date_obj"] else None,
            "customerType": None,
            "jobType": e["job_type"],
            "status": status,
            "reason": None,
            "sales": e["sales"],
            "pax": e["pax"],
        })

    def matches(item):
        if filters.get("from") and (not item["date"] or item["date"] < filters["from"]):
            return False
        if filters.get("to") and (not item["date"] or item["date"] > filters["to"]):
            return False
        if filters.get("customerType") and item["customerType"] != filters["customerType"]:
            return False
        if filters.get("jobType") and item["jobType"] != filters["jobType"]:
            return False
        if filters.get("status") and item["status"] != filters["status"]:
            return False
        if filters.get("paxMin") is not None and (item["pax"] or 0) < filters["paxMin"]:
            return False
        if filters.get("paxMax") is not None and (item["pax"] or 0) > filters["paxMax"]:
            return False
        return True

    filtered = [it for it in items if matches(it)]
    filtered.sort(key=lambda it: it["date"] or "", reverse=True)
    return {"items": filtered}
