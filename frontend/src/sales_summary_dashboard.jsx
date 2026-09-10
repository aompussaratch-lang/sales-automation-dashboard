import { useState, useMemo, useEffect, useCallback, useRef, Fragment } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell,
} from "recharts";
import {
  LayoutGrid, Upload, BarChart3, History, Palette, Bell, Users, LogOut, Menu, Search,
  RefreshCw, Download, ChevronDown, ChevronLeft, ChevronRight, XCircle, Briefcase, Award, FileSpreadsheet,
  FileText, CheckCircle2, AlertCircle, Cloud,
} from "lucide-react";
import { api, pollUploadStatus } from "./api";

// ---------------------------------------------------------------------------
// Design tokens (sampled from the reference design)
// ---------------------------------------------------------------------------
const ink = "#17233B";
const inkSoft = "#64748B";
const inkFaint = "#94A3B8";
const bgApp = "#F5F8FE";
const surface = "#FFFFFF";
const line = "#E7EAF0";

const sidebarBg = "#071B33";
const sidebarPanelBg = "#152A46";
const sidebarActiveBg = "#0B386E";
const sidebarText = "#B9C6DE";
const sidebarTextDim = "#7286A6";

const navyPrimary = "#064291";
const chartBlue = "#3595FD";
const green = "#3CA566";
const red = "#F5555C";
const redText = "#F83631";
const yellow = "#FDB900";
const purple = "#997BE9";
const grayNeutral = "#B9C2CE";

const kpi1IconBg = "#FDEBEB";
const kpi2IconBg = "#FEF0DB";
const kpi3IconBg = "#D6F1DE";
const kpi4IconBg = "#E3ECFB";

const FONT = "'Noto Sans Thai', sans-serif";

// ---------------------------------------------------------------------------
// ค่าคงที่ / helper — ตัวเลขจริงทั้งหมดตอนนี้มาจาก backend ผ่าน api.js (ดู useEffect ใน
// SalesSummaryDashboard ด้านล่าง) แทน mock data เดิมที่เคย hardcode ไว้ตรงนี้
// ---------------------------------------------------------------------------
const CHART_PALETTE = [chartBlue, yellow, green, purple, red, grayNeutral];

const PROCESSING_STAGES = ["กำลังอัพโหลดไฟล์", "กำลังตรวจสอบและประมวลผลข้อมูล", "กำลังซิงก์ขึ้น Google Drive"];
const STAGE_INDEX = { uploading: 0, parsing: 1, syncing_drive: 2 };
const THAI_MONTHS_ABBR = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const THAI_MONTHS_FULL = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

function pad2(n) { return String(n).padStart(2, "0"); }
function toISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function getMonthRange(date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return {
    from: `${first.getFullYear()}-${pad2(first.getMonth() + 1)}-${pad2(first.getDate())}`,
    to: `${last.getFullYear()}-${pad2(last.getMonth() + 1)}-${pad2(last.getDate())}`,
  };
}

function getNextSaturday9am(from = new Date()) {
  const target = new Date(from);
  const day = target.getDay();
  const daysUntil = (6 - day + 7) % 7;
  target.setDate(target.getDate() + daysUntil);
  target.setHours(9, 0, 0, 0);
  if (target <= from) target.setDate(target.getDate() + 7);
  return target;
}

function formatThaiDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const time = d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
  return `${d.getDate()} ${THAI_MONTHS_ABBR[d.getMonth()]} ${d.getFullYear() + 543}, ${time} น.`;
}

// ---------------------------------------------------------------------------
// Manpower calendar — จัดกลุ่มข้อมูลรายวันจริงจาก GET /summary/manpower-calendar เป็นตารางรายสัปดาห์
// (ตามที่ api_schema.md แนะนำ: backend ส่งรายวัน frontend จัดกลุ่มเป็นสัปดาห์เอง)
// ---------------------------------------------------------------------------
function buildManpowerWeeks(fromStr, toStr, daysData) {
  const byDate = new Map((daysData || []).map((d) => [d.date, d]));
  const from = new Date(fromStr);
  const to = new Date(toStr);
  const startOfWeek = (d) => {
    const day = (d.getDay() + 6) % 7;
    const s = new Date(d);
    s.setDate(d.getDate() - day);
    return s;
  };
  const gridStart = startOfWeek(from);
  const gridEnd = startOfWeek(to);
  gridEnd.setDate(gridEnd.getDate() + 6);

  const weeks = [];
  let cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cursor);
      const inRange = d >= from && d <= to;
      const rec = inRange ? byDate.get(toISODate(d)) : null;
      days.push({
        date: d,
        count: inRange ? (rec ? rec.count : 0) : null,
        jobs: rec ? rec.jobs : [],
        totalPax: rec ? rec.totalPax : 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(days);
  }
  return weeks;
}

// การ์ด "งาน Confirmed ตามเดือน" — จัดกลุ่มข้อมูลรายวันช่วงที่เลือกเป็นรายเดือน (api_schema.md ไม่มี
// endpoint แยกสำหรับสรุปรายเดือน จึงคำนวณฝั่ง frontend จากข้อมูลรายวันช่วงเดียวกับตารางด้านล่าง)
function buildMonthlyConfirmed(daysData) {
  const totals = new Map();
  (daysData || []).forEach((d) => {
    const dt = new Date(d.date);
    const key = `${dt.getFullYear()}-${dt.getMonth()}`;
    const entry = totals.get(key) || {
      name: `${THAI_MONTHS_ABBR[dt.getMonth()]} ${String(dt.getFullYear() + 543).slice(-2)}`,
      value: 0,
      order: dt.getFullYear() * 12 + dt.getMonth(),
    };
    entry.value += d.count;
    totals.set(key, entry);
  });
  return Array.from(totals.values()).sort((a, b) => a.order - b.order);
}

function heatColor(count) {
  if (count === null) return "transparent";
  if (count === 0) return "#EEF1F5";
  if (count <= 2) return "#BFD9FB";
  if (count <= 4) return "#7FB4F8";
  if (count <= 6) return "#4A98F6";
  return chartBlue;
}
function heatTextColor(count) {
  if (count === null) return "transparent";
  return count >= 5 ? "#FFFFFF" : ink;
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------
function Card({ children, style, className = "" }) {
  return (
    <div style={{ background: surface, border: `1px solid ${line}`, borderRadius: 14, ...style }} className={`p-5 ${className}`}>
      {children}
    </div>
  );
}

function TrendBadge({ current, previous, goodDirection }) {
  const diff = current - previous;
  if (diff === 0) return <span style={{ color: inkFaint }} className="text-xs">เท่ากับช่วงก่อนหน้า</span>;
  const pct = previous ? Math.round((Math.abs(diff) / previous) * 100) : 0;
  const isIncrease = diff > 0;
  const isGood = goodDirection === "up" ? isIncrease : !isIncrease;
  return (
    <span style={{ color: isGood ? green : redText }} className="text-xs font-medium">
      {isIncrease ? "▲" : "▼"} {pct}% จากช่วงก่อนหน้า
    </span>
  );
}

function KpiCard({ icon, iconBg, label, value, unit, trend, valueColor }) {
  return (
    <Card style={{ flex: 1, minWidth: 220 }}>
      <div className="flex items-start justify-between mb-4">
        <p style={{ color: inkSoft, fontFamily: FONT }} className="text-sm">{label}</p>
        <div style={{ background: iconBg, borderRadius: 10, width: 40, height: 40 }} className="flex items-center justify-center shrink-0">
          {icon}
        </div>
      </div>
      <div className="flex items-baseline gap-1.5 mb-1.5">
        <span style={{ color: valueColor || ink, fontFamily: FONT }} className="text-3xl font-bold">{value}</span>
        {unit && <span style={{ color: inkSoft }} className="text-sm">{unit}</span>}
      </div>
      {trend}
    </Card>
  );
}

function SectionHeading({ icon, iconBg, title, subtitle }) {
  return (
    <div className="flex items-center gap-3 mb-4 mt-1">
      <div style={{ background: iconBg, borderRadius: 8 }} className="w-8 h-8 flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div>
        <p style={{ color: ink, fontFamily: FONT }} className="text-base font-bold leading-tight">{title}</p>
        {subtitle && <p style={{ color: inkFaint }} className="text-xs">{subtitle}</p>}
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: ink, borderRadius: 8, fontFamily: FONT }} className="px-3 py-2 text-xs shadow-lg">
      {label && <p style={{ color: "#CBD5E1" }} className="mb-1">{label}</p>}
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color || "#FFFFFF" }}>{p.name}: {p.value}</p>
      ))}
    </div>
  );
}

function DetailList({ title, onClose, rows, columns, loading }) {
  return (
    <div className="mt-4 pt-4" style={{ borderTop: `1px solid ${line}` }}>
      <div className="flex items-center justify-between mb-2">
        <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold">{title}</p>
        <button onClick={onClose} style={{ color: inkSoft }} className="text-xs underline shrink-0">ปิด</button>
      </div>
      {loading ? (
        <p style={{ color: inkFaint }} className="text-xs py-3">กำลังโหลด...</p>
      ) : rows.length === 0 ? (
        <p style={{ color: inkFaint }} className="text-xs py-3">ไม่พบข้อมูลในช่วงที่เลือก</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: `1px solid ${line}` }}>
              {columns.map((c) => (
                <th key={c.key} style={{ color: inkSoft }} className={`font-normal py-2 ${c.align === "right" ? "text-right" : "text-left"}`}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${line}` : "none" }}>
                {columns.map((c) => (
                  <td key={c.key} style={{ color: ink }} className={`py-2 ${c.align === "right" ? "text-right" : ""}`}>{r[c.key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EmptyState({ onUpload, processing, canUpload }) {
  return (
    <Card style={{ borderStyle: "dashed" }} className="flex flex-col items-center justify-center text-center py-16 px-6 mb-6">
      <div style={{ background: bgApp, borderRadius: 999 }} className="p-4 mb-4">
        <Upload size={20} style={{ color: navyPrimary }} />
      </div>
      <p style={{ color: ink, fontFamily: FONT }} className="text-lg font-semibold mb-1">ยังไม่มีข้อมูลสำหรับช่วงเวลานี้</p>
      {canUpload ? (
        <>
          <p style={{ color: inkSoft }} className="text-sm max-w-sm mb-5">อัปโหลดไฟล์ Calendar และ Cancelled เพื่อเริ่มสร้างรายงานสรุปอัตโนมัติ</p>
          <button onClick={onUpload} disabled={processing} style={{ background: navyPrimary, color: "#fff", opacity: processing ? 0.6 : 1 }} className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium">
            <Upload size={15} /> อัปโหลดไฟล์
          </button>
        </>
      ) : (
        <p style={{ color: inkSoft }} className="text-sm max-w-sm">รอ Sales อัปโหลดไฟล์ Calendar และ Cancelled ของรอบนี้</p>
      )}
    </Card>
  );
}

const NAV_ITEMS = [
  { key: "overview", label: "ภาพรวม", icon: LayoutGrid },
  { key: "functionsheet", label: "อัปเดตสถานะ Function Sheet", icon: FileText },
  { key: "upload", label: "อัปโหลดข้อมูล", icon: Upload },
  { key: "reports", label: "รายงาน", icon: BarChart3 },
  { key: "history", label: "ประวัติการอัปโหลด", icon: History },
  { key: "colors", label: "ตั้งค่าสถานะสี", icon: Palette },
  { key: "alerts", label: "ตั้งค่าแจ้งเตือน", icon: Bell },
  { key: "users", label: "ผู้ใช้งาน", icon: Users },
];

const FS_STATUS_LABEL = { issued: "ออกแล้ว", not_due: "ยังไม่ถึงกำหนด", urgent: "ใกล้ครบกำหนด/เลยกำหนด" };
const FS_STATUS_COLOR = { issued: green, not_due: inkFaint, urgent: redText };

// ---------------------------------------------------------------------------
// หน้า "อัปเดตสถานะ Function Sheet" — ตารางงาน Confirmed พร้อมกรอกวันที่ออก Function Sheet ทีละงาน
// ---------------------------------------------------------------------------
function FunctionSheetPage({ role, dateFrom, dateTo }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api(role).functionSheetList(dateFrom, dateTo)
      .then((res) => setItems(res.items))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [role, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  async function handleSave(id, value) {
    setSavingId(id);
    try {
      await api(role).updateFunctionSheet(id, value || null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <Card>
      <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold mb-1">อัปเดตสถานะ Function Sheet</p>
      <p style={{ color: inkFaint }} className="text-xs mb-4">Function Sheet ต้องออกก่อนวันจัดงานอย่างน้อย 14 วัน — กรอกวันที่ออกแล้วกดบันทึกทีละงาน</p>
      {error && <p style={{ color: redText }} className="text-xs mb-3">{error}</p>}
      {loading ? (
        <p style={{ color: inkFaint }} className="text-sm py-4">กำลังโหลด...</p>
      ) : items.length === 0 ? (
        <p style={{ color: inkFaint }} className="text-sm py-4">ไม่มีงาน Confirmed ในช่วงวันที่ที่เลือก</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: `1px solid ${line}` }}>
                <th style={{ color: inkFaint }} className="text-left font-normal py-2 text-xs">ชื่องาน</th>
                <th style={{ color: inkFaint }} className="text-left font-normal py-2 text-xs">วันจัดงาน</th>
                <th style={{ color: inkFaint }} className="text-left font-normal py-2 text-xs">Sales</th>
                <th style={{ color: inkFaint }} className="text-right font-normal py-2 text-xs">จำนวนคน</th>
                <th style={{ color: inkFaint }} className="text-left font-normal py-2 text-xs">สถานะ</th>
                <th style={{ color: inkFaint }} className="text-left font-normal py-2 text-xs">วันที่ออก Function Sheet</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} style={{ borderBottom: `1px solid ${line}` }}>
                  <td style={{ color: ink }} className="py-2 max-w-[220px] truncate" title={it.title}>{it.title}</td>
                  <td style={{ color: ink }} className="py-2 whitespace-nowrap">{it.date}</td>
                  <td style={{ color: inkSoft }} className="py-2">{it.sales || "-"}</td>
                  <td style={{ color: ink }} className="py-2 text-right">{it.pax}</td>
                  <td className="py-2">
                    <span style={{ color: FS_STATUS_COLOR[it.status] }} className="text-xs font-medium">
                      {FS_STATUS_LABEL[it.status]}
                    </span>
                  </td>
                  <td className="py-2">
                    <input
                      type="date"
                      defaultValue={it.issuedAt || ""}
                      disabled={savingId === it.id}
                      onBlur={(e) => { if (e.target.value !== (it.issuedAt || "")) handleSave(it.id, e.target.value); }}
                      style={{ border: `1px solid ${line}`, borderRadius: 6 }}
                      className="px-2 py-1 text-xs"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// หน้า "อัปโหลดข้อมูล" — กรอกงานทีละรายการด้วยมือ (ทางเลือกแทนอัปโหลดไฟล์ ระหว่างที่ปุ่มอัปโหลด
// ไฟล์ในเบราว์เซอร์ยังมีปัญหาเฉพาะบางสภาพแวดล้อม — ไม่ใช้ file input เลยจึงไม่เจอปัญหาเดียวกัน)
// ---------------------------------------------------------------------------
const EMPTY_MANUAL_FORM = {
  status: "Cancelled",
  date: "",
  customerName: "",
  customerType: "",
  jobType: "",
  pax: "",
  sales: "",
  reason: "",
  location: "",
};

function ManualEntryPage({ role, onSaved }) {
  const [form, setForm] = useState(EMPTY_MANUAL_FORM);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  function set(key, value) { setForm((f) => ({ ...f, [key]: value })); }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.date) { setMessage({ type: "error", text: "กรุณาเลือกวันที่" }); return; }
    setSaving(true);
    setMessage(null);
    try {
      await api(role).manualEntry({
        status: form.status,
        date: form.date,
        customerName: form.customerName || null,
        customerType: form.customerType || null,
        jobType: form.jobType || null,
        pax: form.pax ? Number(form.pax) : null,
        sales: form.sales || null,
        reason: form.reason || null,
        location: form.location || null,
      });
      setMessage({ type: "success", text: "บันทึกงานสำเร็จแล้ว" });
      setForm(EMPTY_MANUAL_FORM);
      onSaved?.();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSaving(false);
    }
  }

  const inputStyle = { border: `1px solid ${line}`, borderRadius: 8 };

  return (
    <Card style={{ maxWidth: 560 }}>
      <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold mb-1">อัปโหลดข้อมูล — กรอกทีละรายการ</p>
      <p style={{ color: inkFaint }} className="text-xs mb-4">
        ทางเลือกสำหรับเพิ่มงานทีละรายการด้วยมือ (ไม่แทนที่ไฟล์ที่อัปโหลดไว้ — แค่เพิ่มเข้าไป)
        ถ้าต้องการนำเข้าทีละหลายรายการ ใช้ปุ่ม "อัปโหลดไฟล์" มุมขวาบนแทน
      </p>
      {message && (
        <p style={{ color: message.type === "success" ? green : redText }} className="text-xs mb-3">{message.text}</p>
      )}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div>
          <label style={{ color: inkSoft }} className="text-xs block mb-1">สถานะ</label>
          <select value={form.status} onChange={(e) => set("status", e.target.value)} style={inputStyle} className="w-full px-2 py-1.5 text-sm">
            <option value="Cancelled">ยกเลิก (Cancelled)</option>
            <option value="Confirmed">ยืนยันแล้ว (Confirmed)</option>
          </select>
        </div>
        <div>
          <label style={{ color: inkSoft }} className="text-xs block mb-1">วันที่จัดงาน *</label>
          <input type="date" required value={form.date} onChange={(e) => set("date", e.target.value)} style={inputStyle} className="w-full px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label style={{ color: inkSoft }} className="text-xs block mb-1">ชื่อลูกค้า/ชื่องาน</label>
          <input type="text" value={form.customerName} onChange={(e) => set("customerName", e.target.value)} style={inputStyle} className="w-full px-2 py-1.5 text-sm" />
        </div>
        {form.status === "Cancelled" ? (
          <div>
            <label style={{ color: inkSoft }} className="text-xs block mb-1">ประเภทลูกค้า (A/B/C/N)</label>
            <input type="text" maxLength={1} value={form.customerType} onChange={(e) => set("customerType", e.target.value.toUpperCase())} style={inputStyle} className="w-full px-2 py-1.5 text-sm" />
          </div>
        ) : (
          <div>
            <label style={{ color: inkSoft }} className="text-xs block mb-1">ห้อง</label>
            <input type="text" value={form.location} onChange={(e) => set("location", e.target.value)} style={inputStyle} className="w-full px-2 py-1.5 text-sm" />
          </div>
        )}
        <div>
          <label style={{ color: inkSoft }} className="text-xs block mb-1">ประเภทงาน (เช่น MT, WD, DN)</label>
          <input type="text" value={form.jobType} onChange={(e) => set("jobType", e.target.value.toUpperCase())} style={inputStyle} className="w-full px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label style={{ color: inkSoft }} className="text-xs block mb-1">จำนวนคน</label>
          <input type="number" min="0" value={form.pax} onChange={(e) => set("pax", e.target.value)} style={inputStyle} className="w-full px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label style={{ color: inkSoft }} className="text-xs block mb-1">Sales</label>
          <input type="text" value={form.sales} onChange={(e) => set("sales", e.target.value)} style={inputStyle} className="w-full px-2 py-1.5 text-sm" />
        </div>
        {form.status === "Cancelled" && (
          <div>
            <label style={{ color: inkSoft }} className="text-xs block mb-1">เหตุผลที่ยกเลิก</label>
            <input type="text" value={form.reason} onChange={(e) => set("reason", e.target.value)} style={inputStyle} className="w-full px-2 py-1.5 text-sm" />
          </div>
        )}
        <button type="submit" disabled={saving}
          style={{ background: navyPrimary, color: "#fff", opacity: saving ? 0.6 : 1 }}
          className="px-4 py-2 rounded-lg text-sm font-medium mt-2">
          {saving ? "กำลังบันทึก..." : "บันทึกงาน"}
        </button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// หน้า "ประวัติการอัปโหลด" แบบเต็ม — ก่อนหน้านี้มีแค่การ์ดย่อย 2 รายการล่าสุดในหน้า Overview
// ---------------------------------------------------------------------------
function UploadHistoryPage({ role }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    api(role).uploadHistory()
      .then((res) => { if (!ignore) setItems(res.items); })
      .catch((err) => { if (!ignore) setError(err.message); })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [role]);

  return (
    <Card>
      <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold mb-4">ประวัติการอัปโหลดไฟล์</p>
      {error && <p style={{ color: redText }} className="text-xs mb-3">{error}</p>}
      {loading ? (
        <p style={{ color: inkFaint }} className="text-sm py-4">กำลังโหลด...</p>
      ) : items.length === 0 ? (
        <p style={{ color: inkFaint }} className="text-sm py-4">ยังไม่มีประวัติการอัปโหลด</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: `1px solid ${line}` }}>
                <th style={{ color: inkFaint }} className="text-left font-normal py-2 text-xs">ชื่อไฟล์</th>
                <th style={{ color: inkFaint }} className="text-left font-normal py-2 text-xs">ประเภทไฟล์</th>
                <th style={{ color: inkFaint }} className="text-left font-normal py-2 text-xs">วันเวลาที่อัปโหลด</th>
                <th style={{ color: inkFaint }} className="text-left font-normal py-2 text-xs">ผู้อัปโหลด</th>
                <th style={{ color: inkFaint }} className="text-left font-normal py-2 text-xs">สถานะ</th>
                <th style={{ color: inkFaint }} className="text-right font-normal py-2 text-xs">รายการ</th>
              </tr>
            </thead>
            <tbody>
              {items.map((h) => (
                <tr key={h.id} style={{ borderBottom: `1px solid ${line}` }}>
                  <td style={{ color: ink }} className="py-2">{h.fileName}</td>
                  <td style={{ color: inkSoft }} className="py-2">{h.type}</td>
                  <td style={{ color: inkSoft }} className="py-2 whitespace-nowrap">{formatThaiDateTime(h.uploadedAt)}</td>
                  <td style={{ color: inkSoft }} className="py-2">{h.uploadedBy}</td>
                  <td className="py-2">
                    <span style={{ color: h.fileStatus === "ผ่าน" ? green : redText }} className="text-xs font-medium">{h.fileStatus}</span>
                  </td>
                  <td style={{ color: ink }} className="py-2 text-right">{h.rows.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function SalesSummaryDashboard() {
  const [role, setRole] = useState("sales");
  const canUpload = role === "sales";
  const [userName, setUserName] = useState(null);
  const fileInputRef = useRef(null);

  const [activeNav, setActiveNav] = useState("overview");
  const [dateFrom, setDateFrom] = useState("2026-05-01");
  const [dateTo, setDateTo] = useState("2026-05-31");
  const [quickFilter, setQuickFilter] = useState("month");

  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState("-");
  const [toast, setToast] = useState(null);
  const [summaryError, setSummaryError] = useState(null);

  const [hasData, setHasData] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [processingStage, setProcessingStage] = useState(0);
  const [processingProgress, setProcessingProgress] = useState(0);

  const [driveStatus, setDriveStatus] = useState("synced");
  const [driveLastSync, setDriveLastSync] = useState("-");
  const [uploadHistory, setUploadHistory] = useState([]);

  // ⬇⬇ ข้อมูลจริงจาก backend (แทน mock data เดิมทั้งหมด) — โหลดผ่าน loadSummary() ด้านล่าง ⬇⬇
  const [kpi, setKpi] = useState(null);
  const [cancellations, setCancellations] = useState(null);
  const [jobStatusData, setJobStatusData] = useState([]);
  const [manpowerDays, setManpowerDays] = useState([]);
  const [confirmedStats, setConfirmedStats] = useState(null);
  const [dataQuality, setDataQuality] = useState(null);
  const [fsSummary, setFsSummary] = useState({ notIssuedCount: 0, urgentCount: 0 });

  const [selectedCustomerType, setSelectedCustomerType] = useState(null);
  const [selectedJobTypeCancel, setSelectedJobTypeCancel] = useState(null);
  const [selectedStatusSegment, setSelectedStatusSegment] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null);
  const [showManpowerDetail, setShowManpowerDetail] = useState(true);
  const [detailRows, setDetailRows] = useState({ customerType: [], jobType: [], status: [] });
  const [detailLoading, setDetailLoading] = useState({ customerType: false, jobType: false, status: false });

  const customerTypeData = useMemo(
    () => (cancellations?.byCustomerType || []).map((d, i) => ({ ...d, color: CHART_PALETTE[i % CHART_PALETTE.length] })),
    [cancellations]
  );
  const jobTypeCancelData = cancellations?.byJobType || [];
  const cancelReasons = cancellations?.reasons || [];
  const salesRanking = cancellations?.salesRanking || [];
  const totalReasons = cancelReasons.reduce((a, b) => a + b.count, 0) || 1;

  const totalCancelledJobs = kpi?.cancelledJobs?.current ?? 0;
  const topJobType = jobTypeCancelData[0] || { name: "-", value: 0 };
  const topSales = salesRanking[0] || { name: "-", count: 0 };

  const totalConfirmedJobs = kpi?.confirmedTotal?.current ?? 0;

  // สัดส่วนสถานะโดยรวม (Confirmed/Pending/Cancelled) — รวมจาก jobStatusData ที่มีอยู่แล้ว ไม่ต้องยิง API เพิ่ม
  const overallStatusData = useMemo(() => {
    const totals = jobStatusData.reduce(
      (acc, r) => ({ confirmed: acc.confirmed + r.confirmed, pending: acc.pending + r.pending, cancelled: acc.cancelled + r.cancelled }),
      { confirmed: 0, pending: 0, cancelled: 0 }
    );
    return [
      { name: "Confirmed", value: totals.confirmed, color: green },
      { name: "Pending", value: totals.pending, color: yellow },
      { name: "Cancelled", value: totals.cancelled, color: red },
    ].filter((d) => d.value > 0);
  }, [jobStatusData]);
  const overallStatusTotal = overallStatusData.reduce((a, b) => a + b.value, 0) || 1;

  const confirmedBySales = confirmedStats?.bySales || [];
  const confirmedByRoom = confirmedStats?.byRoom || [];

  const nextReminder = useMemo(() => getNextSaturday9am(), []);
  const daysUntilReminder = useMemo(() => Math.max(0, Math.ceil((nextReminder - new Date()) / 86400000)), [nextReminder]);

  const manpowerWeeks = useMemo(() => buildManpowerWeeks(dateFrom, dateTo, manpowerDays), [dateFrom, dateTo, manpowerDays]);
  const weeklyTotals = useMemo(() => manpowerWeeks.map((w) => w.reduce((s, d) => s + (d.count || 0), 0)), [manpowerWeeks]);
  const daysInRange = useMemo(() => manpowerWeeks.flat().filter((d) => d.count !== null), [manpowerWeeks]);
  const peakDay = useMemo(() => daysInRange.reduce((max, d) => (d.count > (max?.count ?? -1) ? d : max), null), [daysInRange]);
  const monthlyConfirmedData = useMemo(() => buildMonthlyConfirmed(manpowerDays), [manpowerDays]);

  useEffect(() => { setSelectedDay(null); }, [dateFrom, dateTo]);

  const calendarMonthLabel = useMemo(() => {
    const d = new Date(dateFrom);
    return `${THAI_MONTHS_FULL[d.getMonth()]} ${d.getFullYear() + 543}`;
  }, [dateFrom]);

  function goToMonth(offset) {
    const d = new Date(dateFrom);
    d.setDate(1);
    d.setMonth(d.getMonth() + offset);
    const range = getMonthRange(d);
    setDateFrom(range.from);
    setDateTo(range.to);
    setQuickFilter("custom");
  }

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(null), 2200); }

  // โหลดชื่อผู้ใช้จริงจาก GET /auth/me ทุกครั้งที่สลับ role (ยังไม่มีระบบ login จริง — role switcher
  // นี้จับคู่กับ demo token คงที่ต่อ role ใน api.js เพื่อให้ backend บังคับสิทธิ์ได้จริงตาม api_schema.md)
  useEffect(() => {
    let ignore = false;
    api(role).me().then((u) => { if (!ignore) setUserName(u.name); }).catch(() => {});
    return () => { ignore = true; };
  }, [role]);

  // ดึงข้อมูลสรุปทั้งหมดสำหรับ dashboard จาก backend ตามช่วงวันที่/role ที่เลือก
  const loadSummary = useCallback(async () => {
    const client = api(role);
    const [kpiRes, cancelRes, jobStatusRes, manpowerRes, confirmedStatsRes, qualityRes, fsRes, driveRes, historyRes] = await Promise.all([
      client.kpi(dateFrom, dateTo),
      client.cancellations(dateFrom, dateTo),
      client.jobStatus(dateFrom, dateTo),
      client.manpowerCalendar(dateFrom, dateTo),
      client.confirmedStats(dateFrom, dateTo),
      client.dataQuality(),
      client.functionSheetList(dateFrom, dateTo),
      client.driveStatus(),
      canUpload ? client.uploadHistory() : Promise.resolve({ items: [] }),
    ]);
    setKpi(kpiRes);
    setCancellations(cancelRes);
    setJobStatusData(jobStatusRes.data);
    setManpowerDays(manpowerRes.days);
    setConfirmedStats(confirmedStatsRes);
    setDataQuality(qualityRes);
    setFsSummary({ notIssuedCount: fsRes.notIssuedCount, urgentCount: fsRes.urgentCount });
    setDriveStatus(driveRes.status);
    setDriveLastSync(formatThaiDateTime(driveRes.lastSyncAt));
    setUploadHistory(historyRes.items.map((h) => ({ ...h, uploadedAt: formatThaiDateTime(h.uploadedAt) })));
    setLastUpdated(formatThaiDateTime(new Date().toISOString()));
  }, [role, dateFrom, dateTo, canUpload]);

  useEffect(() => {
    let ignore = false;
    setSummaryError(null);
    loadSummary().catch((err) => { if (!ignore) setSummaryError(err.message); });
    return () => { ignore = true; };
  }, [loadSummary]);

  // drill-down: ยิง GET /events ทุกครั้งที่คลิกส่วนของกราฟ แทน sampleRows() แบบสุ่มเดิม
  useEffect(() => {
    if (!selectedCustomerType) { setDetailRows((s) => ({ ...s, customerType: [] })); return; }
    let ignore = false;
    setDetailLoading((s) => ({ ...s, customerType: true }));
    api(role).events({ from: dateFrom, to: dateTo, customerType: selectedCustomerType.replace(/^ลค\.?/, ""), status: "cancelled" })
      .then((res) => { if (!ignore) setDetailRows((s) => ({ ...s, customerType: res.items })); })
      .catch(() => { if (!ignore) setDetailRows((s) => ({ ...s, customerType: [] })); })
      .finally(() => { if (!ignore) setDetailLoading((s) => ({ ...s, customerType: false })); });
    return () => { ignore = true; };
  }, [selectedCustomerType, dateFrom, dateTo, role]);

  useEffect(() => {
    if (!selectedJobTypeCancel) { setDetailRows((s) => ({ ...s, jobType: [] })); return; }
    let ignore = false;
    setDetailLoading((s) => ({ ...s, jobType: true }));
    // หมวด "ไม่ระบุ" คือ event ที่แกะ job_type ไม่ได้ฝั่ง backend (ดู backend/README.md) — ยังไม่รองรับ
    // filter "ไม่มี job_type" ใน /events ตอนนี้ จึงไม่ส่ง jobType filter ให้กรณีนี้
    const jobType = selectedJobTypeCancel === "ไม่ระบุ" ? undefined : selectedJobTypeCancel;
    api(role).events({ from: dateFrom, to: dateTo, jobType, status: "cancelled" })
      .then((res) => { if (!ignore) setDetailRows((s) => ({ ...s, jobType: res.items })); })
      .catch(() => { if (!ignore) setDetailRows((s) => ({ ...s, jobType: [] })); })
      .finally(() => { if (!ignore) setDetailLoading((s) => ({ ...s, jobType: false })); });
    return () => { ignore = true; };
  }, [selectedJobTypeCancel, dateFrom, dateTo, role]);

  useEffect(() => {
    if (!selectedStatusSegment) { setDetailRows((s) => ({ ...s, status: [] })); return; }
    let ignore = false;
    setDetailLoading((s) => ({ ...s, status: true }));
    const jobType = selectedStatusSegment.jobType === "ไม่ระบุ" ? undefined : selectedStatusSegment.jobType;
    api(role).events({ from: dateFrom, to: dateTo, jobType, status: selectedStatusSegment.status })
      .then((res) => { if (!ignore) setDetailRows((s) => ({ ...s, status: res.items })); })
      .catch(() => { if (!ignore) setDetailRows((s) => ({ ...s, status: [] })); })
      .finally(() => { if (!ignore) setDetailLoading((s) => ({ ...s, status: false })); });
    return () => { ignore = true; };
  }, [selectedStatusSegment, dateFrom, dateTo, role]);

  function handleRefresh() {
    setRefreshing(true);
    loadSummary()
      .then(() => showToast("อัปเดตข้อมูลล่าสุดแล้ว"))
      .catch((err) => showToast(`รีเฟรชไม่สำเร็จ: ${err.message}`))
      .finally(() => setRefreshing(false));
  }

  async function handleDownload(kind) {
    const format = kind === "PDF" ? "pdf" : "csv";
    showToast(`กำลังสร้างไฟล์ ${kind} สำหรับดาวน์โหลด`);
    try {
      await api(role).downloadReport(format, dateFrom, dateTo);
    } catch (err) {
      showToast(`ดาวน์โหลดไม่สำเร็จ: ${err.message}`);
    }
  }

  function triggerUpload() {
    if (processing) return;
    fileInputRef.current?.click();
  }

  async function handleFilesSelected(e) {
    const fileList = e.target.files;
    e.target.value = ""; // เผื่อผู้ใช้อยากเลือกไฟล์เดิมซ้ำอีกครั้ง
    if (!fileList || fileList.length === 0) return;

    setProcessing(true);
    setProcessingStage(0);
    setProcessingProgress(5);
    setDriveStatus("syncing");
    try {
      const { jobId } = await api(role).upload(fileList);
      pollUploadStatus(role, jobId, (status) => {
        setProcessingProgress(status.progress ?? 0);
        setProcessingStage(STAGE_INDEX[status.stage] ?? 0);
        if (status.status === "done") {
          setProcessing(false);
          setHasData(true);
          showToast("ประมวลผลและซิงก์ข้อมูลขึ้น Google Drive สำเร็จ");
          loadSummary().catch((err) => setSummaryError(err.message));
        } else if (status.status === "failed") {
          setProcessing(false);
          showToast(`อัปโหลดไม่สำเร็จ: ${status.error || "ไม่ทราบสาเหตุ"}`);
          loadSummary().catch((err) => setSummaryError(err.message));
        }
      });
    } catch (err) {
      setProcessing(false);
      showToast(`อัปโหลดไม่สำเร็จ: ${err.message}`);
    }
  }

  return (
    <div style={{ background: bgApp, minHeight: "100%", fontFamily: FONT }} className="w-full flex">
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;500;600;700&display=swap');`}</style>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".xlsx,.xls,.csv"
        onChange={handleFilesSelected}
        style={{ display: "none" }}
      />

      {/* ================= SIDEBAR ================= */}
      <div style={{ background: sidebarBg, width: 232, flexShrink: 0 }} className="flex flex-col py-5 px-3 min-h-full">
        <div className="flex items-center gap-2 px-2 mb-6">
          <div style={{ background: "#0F2D52", borderRadius: 8 }} className="w-8 h-8 flex items-center justify-center">
            <BarChart3 size={16} style={{ color: chartBlue }} />
          </div>
          <div>
            <p style={{ color: "#fff" }} className="text-sm font-bold leading-tight">SALES</p>
            <p style={{ color: sidebarTextDim }} className="text-[10px] leading-tight tracking-wide">AUTOMATION</p>
          </div>
        </div>

        <nav className="flex flex-col gap-0.5 mb-5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeNav === item.key;
            return (
              <button
                key={item.key}
                onClick={() => {
                  setActiveNav(item.key);
                  if (!["overview", "functionsheet", "history", "upload"].includes(item.key)) {
                    showToast(`หน้า "${item.label}" ยังไม่ได้สร้างในต้นแบบนี้`);
                  }
                }}
                style={{ background: active ? sidebarActiveBg : "transparent", color: active ? "#fff" : sidebarText }}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-left"
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
          <button
            onClick={() => showToast("ออกจากระบบ (ตัวอย่างเท่านั้น)")}
            style={{ color: sidebarTextDim }}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-left mt-1"
          >
            <LogOut size={16} /> ออกจากระบบ
          </button>
        </nav>

        <div style={{ background: sidebarPanelBg, borderRadius: 12 }} className="p-3 mb-3">
          <p style={{ color: sidebarText }} className="text-xs mb-2">ช่วงวันที่เลือก</p>
          <div className="flex flex-col gap-1.5">
            <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setQuickFilter("custom"); }}
              style={{ background: "#0F2A4A", border: "1px solid #23405F", color: "#fff", borderRadius: 8 }} className="px-2 py-1.5 text-xs" />
            <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setQuickFilter("custom"); }}
              style={{ background: "#0F2A4A", border: "1px solid #23405F", color: "#fff", borderRadius: 8 }} className="px-2 py-1.5 text-xs" />
          </div>
        </div>

        <div>
          <p style={{ color: sidebarTextDim }} className="text-xs mb-2 px-1">ตัวกรองด่วน</p>
          <div className="flex flex-col gap-0.5">
            {[
              { key: "month", label: "เดือนนี้" },
              { key: "custom", label: "กำหนดเอง" },
            ].map((f) => (
              <button
                key={f.key}
                onClick={() => setQuickFilter(f.key)}
                style={{ background: quickFilter === f.key ? sidebarActiveBg : "transparent", color: quickFilter === f.key ? "#fff" : sidebarText }}
                className="text-left px-3 py-2 rounded-lg text-sm"
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ================= MAIN ================= */}
      <div className="flex-1 min-w-0">
        <div className="max-w-[1300px] mx-auto px-6 py-6">
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
            <div className="flex items-center gap-3">
              <Menu size={18} style={{ color: inkSoft }} />
              <div>
                <p style={{ color: ink, fontFamily: FONT }} className="text-xl font-bold leading-tight">ภาพรวมฝ่ายขาย</p>
                <p style={{ color: inkFaint }} className="text-xs">Sales Automation Dashboard</p>
              </div>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <Search size={16} style={{ color: inkFaint }} />
              <div>
                <p style={{ color: inkSoft }} className="text-xs">อัปเดตล่าสุด</p>
                <p style={{ color: ink }} className="text-xs font-medium">{lastUpdated}</p>
              </div>

              <button onClick={handleRefresh} disabled={processing}
                style={{ border: `1px solid ${line}`, color: ink, background: surface, opacity: processing ? 0.6 : 1 }}
                className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm">
                <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} /> รีเฟรชข้อมูล
              </button>

              {canUpload && (
                <button onClick={triggerUpload} disabled={processing}
                  style={{ background: navyPrimary, color: "#fff", opacity: processing ? 0.6 : 1 }}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium">
                  <Upload size={14} /> อัปโหลดไฟล์
                </button>
              )}

              <div className="relative group">
                <button onClick={() => handleDownload("PDF")}
                  style={{ background: green, color: "#fff" }}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium">
                  <Download size={14} /> ดาวน์โหลด PDF
                </button>
                <button onClick={() => handleDownload("CSV")}
                  style={{ background: ink, color: "#fff" }}
                  className="hidden group-hover:flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium absolute top-full mt-1 right-0 whitespace-nowrap z-10">
                  <Download size={12} /> ดาวน์โหลด CSV
                </button>
              </div>

              <div className="flex items-center gap-2 pl-2" style={{ borderLeft: `1px solid ${line}` }}>
                <div style={{ background: "#DCE6F5", borderRadius: 999 }} className="w-9 h-9 flex items-center justify-center">
                  <Users size={16} style={{ color: navyPrimary }} />
                </div>
                <div>
                  <p style={{ color: ink }} className="text-xs font-semibold leading-tight">
                    {userName || (role === "sales" ? "สมชาย ใจดี" : role === "manager" ? "หัวหน้าฝ่ายขาย" : "ผู้บริหาร")}
                  </p>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    style={{ color: inkFaint, background: "transparent" }}
                    className="text-[11px] -ml-0.5"
                  >
                    <option value="sales">Clerk Sales</option>
                    <option value="manager">หัวหน้าฝ่ายขาย</option>
                    <option value="executive">ผู้บริหาร</option>
                  </select>
                </div>
                <ChevronDown size={14} style={{ color: inkFaint }} />
              </div>
            </div>
          </div>

          {/* Drive sync + reminder strip */}
          <div className="flex flex-wrap items-center gap-4 mb-5 text-xs">
            <div className="flex items-center gap-1.5">
              <span style={{ width: 7, height: 7, borderRadius: 999, background: driveStatus === "synced" ? green : driveStatus === "syncing" ? yellow : red }} />
              <Cloud size={13} style={{ color: inkSoft }} />
              <span style={{ color: inkSoft }}>
                {driveStatus === "synced" && `ซิงก์ Google Drive แล้ว · ${driveLastSync}`}
                {driveStatus === "syncing" && "กำลังซิงก์ขึ้น Google Drive..."}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Bell size={13} style={{ color: inkSoft }} />
              <span style={{ color: inkSoft }}>
                แจ้งเตือนอัปโหลดถัดไป: เสาร์ {nextReminder.getDate()} {THAI_MONTHS_ABBR[nextReminder.getMonth()]} 09:00 น. · อีก {daysUntilReminder} วัน
              </span>
            </div>
            <button onClick={() => setHasData((v) => !v)} style={{ color: navyPrimary }} className="underline">
              {hasData ? "ดูตัวอย่างหน้าว่าง" : "กลับไปดูข้อมูล"}
            </button>
          </div>

          {processing && (
            <Card style={{ marginBottom: 20 }} className="flex items-center gap-4">
              <RefreshCw size={16} className="animate-spin" style={{ color: navyPrimary, flexShrink: 0 }} />
              <div className="flex-1">
                <p style={{ color: ink }} className="text-sm mb-2">{PROCESSING_STAGES[processingStage]}...</p>
                <div style={{ background: bgApp, borderRadius: 999, height: 6, overflow: "hidden" }}>
                  <div style={{ width: `${processingProgress}%`, background: navyPrimary, height: "100%", borderRadius: 999, transition: "width 0.2s linear" }} />
                </div>
              </div>
            </Card>
          )}

          {summaryError && (
            <Card style={{ marginBottom: 20, borderColor: red, background: "#FEF2F2" }} className="flex items-center gap-2 text-sm">
              <AlertCircle size={16} style={{ color: redText, flexShrink: 0 }} />
              <span style={{ color: redText }}>โหลดข้อมูลจาก backend ไม่สำเร็จ: {summaryError}</span>
            </Card>
          )}

          {activeNav === "functionsheet" ? (
            <FunctionSheetPage role={role} dateFrom={dateFrom} dateTo={dateTo} />
          ) : activeNav === "history" ? (
            <UploadHistoryPage role={role} />
          ) : activeNav === "upload" ? (
            <ManualEntryPage role={role} onSaved={() => loadSummary().catch((err) => setSummaryError(err.message))} />
          ) : !hasData ? (
            <EmptyState onUpload={triggerUpload} processing={processing} canUpload={canUpload} />
          ) : (
          <>
          {/* ================= ส่วนที่ 1: งานที่ยืนยันแล้ว (Confirmed) ================= */}
          <SectionHeading
            icon={<CheckCircle2 size={16} style={{ color: green }} />} iconBg={kpi3IconBg}
            title="งานที่ยืนยันแล้ว (Confirmed)"
            subtitle="ภาพรวมงาน Confirmed ในช่วงวันที่ที่เลือก — ใช้วางแผนกำลังคน/ห้อง"
          />
          <div className="flex flex-wrap gap-4 mb-5">
            <KpiCard
              icon={<CheckCircle2 size={18} style={{ color: green }} />} iconBg={kpi3IconBg}
              label="งาน Confirmed ทั้งหมด" value={totalConfirmedJobs} unit="งาน" valueColor={green}
              trend={<TrendBadge current={totalConfirmedJobs} previous={kpi?.confirmedTotal?.previous ?? 0} goodDirection="up" />}
            />
            <KpiCard
              icon={<FileText size={18} style={{ color: fsSummary.urgentCount > 0 ? redText : navyPrimary }} />} iconBg={fsSummary.urgentCount > 0 ? kpi1IconBg : kpi4IconBg}
              label="งาน Confirmed ที่ยังไม่ออก FS" value={fsSummary.notIssuedCount} unit="งาน" valueColor={fsSummary.urgentCount > 0 ? redText : navyPrimary}
              trend={
                fsSummary.urgentCount > 0
                  ? <span style={{ color: redText }} className="text-xs font-medium">⚠ {fsSummary.urgentCount} งานใกล้ครบกำหนด/เลยกำหนด</span>
                  : <span style={{ color: inkSoft }} className="text-xs">ไม่มีงานเร่งด่วน</span>
              }
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
            <Card>
              <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold mb-1">สัดส่วนสถานะงานโดยรวม</p>
              <p style={{ color: inkFaint }} className="text-xs mb-3">รวมทุกประเภทงานในช่วงวันที่ที่เลือก</p>
              <div className="relative mb-3">
                <ResponsiveContainer width="100%" height={140}>
                  <PieChart>
                    <Pie data={overallStatusData} dataKey="value" nameKey="name" innerRadius={40} outerRadius={58} paddingAngle={2}>
                      {overallStatusData.map((d, i) => <Cell key={i} fill={d.color} stroke="none" />)}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none" style={{ marginTop: -10 }}>
                  <p style={{ color: ink, fontFamily: FONT }} className="text-xl font-bold">{overallStatusTotal}</p>
                  <p style={{ color: inkFaint }} className="text-[10px]">งาน</p>
                </div>
              </div>
              <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold mb-1">ประเภทงาน × สถานะ</p>
              <p style={{ color: inkFaint }} className="text-xs mb-3">ข้อมูลจริงจาก backend — "pending" จะมีค่าเมื่อมีไฟล์ปฏิทินที่ export สถานะ Not Confirm/Cut off เพิ่ม</p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={jobStatusData}>
                  <CartesianGrid stroke={line} vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: inkFaint, fontSize: 11 }} axisLine={{ stroke: line }} tickLine={false} />
                  <YAxis tick={{ fill: inkFaint, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                  <Legend wrapperStyle={{ fontSize: 11, color: inkSoft }} />
                  {[
                    { key: "confirmed", label: "Confirmed", color: green },
                    { key: "pending", label: "Pending", color: yellow },
                    { key: "cancelled", label: "Cancelled", color: red },
                  ].map((s) => (
                    <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={s.color} cursor="pointer"
                      onClick={(d) => setSelectedStatusSegment((prev) => (prev && prev.jobType === d.name && prev.status === s.key) ? null : { jobType: d.name, status: s.key, label: s.label, value: d[s.key] })}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              {selectedStatusSegment && (
                <DetailList
                  title={`ตัวอย่างงาน · ${selectedStatusSegment.jobType} (${selectedStatusSegment.label})`}
                  onClose={() => setSelectedStatusSegment(null)}
                  loading={detailLoading.status}
                  rows={detailRows.status}
                  columns={[{ key: "eventName", label: "ชื่องาน" }, { key: "pax", label: "จำนวนคน", align: "right" }, { key: "sales", label: "Sales" }]}
                />
              )}
            </Card>

            <Card>
              <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold mb-4">งาน Confirmed ตาม Sales</p>
              <ResponsiveContainer width="100%" height={420}>
                <BarChart data={confirmedBySales} layout="vertical" margin={{ left: 8 }}>
                  <CartesianGrid stroke={line} horizontal={false} />
                  <XAxis type="number" tick={{ fill: inkFaint, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fill: ink, fontSize: 11 }} axisLine={false} tickLine={false} width={110} />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                  <Bar dataKey="value" name="จำนวนงาน" fill={chartBlue} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card>
              <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold mb-4">งาน Confirmed ตามห้อง</p>
              <ResponsiveContainer width="100%" height={420}>
                <BarChart data={confirmedByRoom} layout="vertical" margin={{ left: 8 }}>
                  <CartesianGrid stroke={line} horizontal={false} />
                  <XAxis type="number" tick={{ fill: inkFaint, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fill: ink, fontSize: 11 }} axisLine={false} tickLine={false} width={110} />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                  <Bar dataKey="value" name="จำนวนงาน" fill={purple} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 mb-8">
            <Card>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold">งาน Confirmed ตามเดือน</p>
                  <p style={{ color: inkFaint }} className="text-xs">รวมรายวันในช่วงวันที่ที่เลือกเป็นรายเดือน (ข้อมูลจริงจาก /summary/manpower-calendar) — เป็นอิสระจากการเลื่อนเดือนในปฏิทินด้านล่าง</p>
                </div>
                <button onClick={() => setShowManpowerDetail((v) => !v)} style={{ color: navyPrimary }} className="text-xs underline shrink-0">
                  {showManpowerDetail ? "ซ่อนรายละเอียดรายวัน" : "ดูรายละเอียดรายวัน"}
                </button>
              </div>
              <ResponsiveContainer width="100%" height={showManpowerDetail ? 160 : 260}>
                <BarChart data={monthlyConfirmedData}>
                  <CartesianGrid stroke={line} vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: inkFaint, fontSize: 11 }} axisLine={{ stroke: line }} tickLine={false} />
                  <YAxis tick={{ fill: inkFaint, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                  <Bar dataKey="value" name="งาน Confirmed" radius={[4, 4, 0, 0]}>
                    {monthlyConfirmedData.map((d, i) => (
                      <Cell key={i} fill={i === monthlyConfirmedData.length - 1 ? navyPrimary : chartBlue} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>

              {showManpowerDetail && (
                <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${line}` }}>
                  <div className="flex items-center justify-between mb-2">
                    <p style={{ color: inkSoft }} className="text-xs">สำหรับวางแผนจัดกำลังคนรายวัน — คลิกวันที่เพื่อดูรายละเอียด</p>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => goToMonth(-1)} style={{ border: `1px solid ${line}`, color: inkSoft, borderRadius: 6 }} className="p-1">
                        <ChevronLeft size={13} />
                      </button>
                      <span style={{ color: ink }} className="text-xs font-medium min-w-[92px] text-center">{calendarMonthLabel}</span>
                      <button onClick={() => goToMonth(1)} style={{ border: `1px solid ${line}`, color: inkSoft, borderRadius: 6 }} className="p-1">
                        <ChevronRight size={13} />
                      </button>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr) 56px", gap: 4 }}>
                    {["จ", "อ", "พ", "พฤ", "ศ", "ส", "อา"].map((d) => (
                      <div key={d} style={{ color: inkFaint }} className="text-[10px] text-center">{d}</div>
                    ))}
                    <div style={{ color: inkFaint }} className="text-[10px] text-center">รวม</div>
                    {manpowerWeeks.map((week, wi) => (
                      <Fragment key={wi}>
                        {week.map((day, di) => {
                          const isPeak = peakDay && day.date.getTime() === peakDay.date.getTime();
                          const isSelected = selectedDay && day.date.getTime() === selectedDay.date.getTime();
                          const clickable = day.count !== null && day.count > 0;
                          return (
                            <div key={di}
                              onClick={() => clickable && setSelectedDay(day)}
                              style={{
                                background: heatColor(day.count), borderRadius: 5, minHeight: 34,
                                opacity: day.count === null ? 0.3 : 1,
                                border: isSelected ? `1.5px solid ${ink}` : isPeak ? `1.5px solid ${yellow}` : "1.5px solid transparent",
                                cursor: clickable ? "pointer" : "default",
                              }}
                              className="flex flex-col items-center justify-center"
                            >
                              <span style={{ color: heatTextColor(day.count), fontSize: 9 }}>{day.date.getDate()}</span>
                              {day.count !== null && <span style={{ color: heatTextColor(day.count) }} className="text-xs font-medium">{day.count}</span>}
                            </div>
                          );
                        })}
                        <div style={{ background: bgApp, border: `1px solid ${line}`, borderRadius: 5, minHeight: 34 }} className="flex items-center justify-center">
                          <span style={{ color: inkSoft }} className="text-xs">{weeklyTotals[wi]}</span>
                        </div>
                      </Fragment>
                    ))}
                  </div>

                  {selectedDay && (
                    <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${line}` }}>
                      <div className="flex items-center justify-between mb-2">
                        <p style={{ color: ink, fontFamily: FONT }} className="text-xs font-semibold">
                          {selectedDay.date.getDate()} {THAI_MONTHS_ABBR[selectedDay.date.getMonth()]} {selectedDay.date.getFullYear() + 543} · {selectedDay.count} งาน · {selectedDay.totalPax.toLocaleString()} คน
                        </p>
                        <button onClick={() => setSelectedDay(null)} style={{ color: inkSoft }} className="text-xs underline">ปิด</button>
                      </div>
                      <table className="w-full text-xs">
                        <tbody>
                          {selectedDay.jobs.map((j, i) => (
                            <tr key={i} style={{ borderBottom: i < selectedDay.jobs.length - 1 ? `1px solid ${line}` : "none" }}>
                              <td style={{ color: ink }} className="py-1.5">{j.type}</td>
                              <td style={{ color: inkSoft }} className="py-1.5">{j.room || "-"}</td>
                              <td style={{ color: inkSoft }} className="py-1.5">{j.time}</td>
                              <td style={{ color: ink }} className="py-1.5 text-right">{j.pax} คน</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>

          {/* ================= ส่วนที่ 2: งานที่ยกเลิก (Cancelled) ================= */}
          <SectionHeading
            icon={<XCircle size={16} style={{ color: redText }} />} iconBg={kpi1IconBg}
            title="งานที่ยกเลิก (Cancelled)"
            subtitle="ภาพรวมงานที่ถูกยกเลิกในช่วงวันที่ที่เลือก"
          />
          <div className="flex flex-wrap gap-4 mb-5">
            <KpiCard
              icon={<XCircle size={18} style={{ color: redText }} />} iconBg={kpi1IconBg}
              label="งานยกเลิกทั้งหมด" value={totalCancelledJobs} unit="งาน" valueColor={redText}
              trend={<TrendBadge current={totalCancelledJobs} previous={kpi?.cancelledJobs?.previous ?? 0} goodDirection="down" />}
            />
            <KpiCard
              icon={<Briefcase size={18} style={{ color: green }} />} iconBg={kpi3IconBg}
              label="ประเภทงานที่ยกเลิกสูงสุด" value={topJobType.name} valueColor={green}
              trend={<span style={{ color: inkSoft }} className="text-xs">{topJobType.value} งาน ({Math.round(topJobType.value / (totalCancelledJobs || 1) * 100)}%)</span>}
            />
            <KpiCard
              icon={<Award size={18} style={{ color: navyPrimary }} />} iconBg={kpi4IconBg}
              label="Sales ที่ยกเลิกสูงสุด" value={topSales.name} valueColor={navyPrimary}
              trend={<span style={{ color: inkSoft }} className="text-xs">{topSales.count} งาน ({Math.round(topSales.count / (salesRanking.reduce((a, b) => a + b.count, 0) || 1) * 100)}%)</span>}
            />
          </div>

          {/* Row 2: donut / job type bar / reasons table */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
            <Card>
              <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold mb-4">งานยกเลิกตามประเภทลูกค้า</p>
              <div className="relative">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={customerTypeData} dataKey="value" nameKey="name"
                      innerRadius={58} outerRadius={82} paddingAngle={2}
                      cursor="pointer"
                      onClick={(d) => setSelectedCustomerType((prev) => (prev === d.name ? null : d.name))}
                    >
                      {customerTypeData.map((d, i) => <Cell key={i} fill={d.color} stroke="none" />)}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none" style={{ marginTop: -8 }}>
                  <p style={{ color: inkFaint }} className="text-xs">รวม</p>
                  <p style={{ color: ink, fontFamily: FONT }} className="text-2xl font-bold">{totalCancelledJobs}</p>
                  <p style={{ color: inkFaint }} className="text-xs">งาน</p>
                </div>
              </div>
              <div className="flex flex-col gap-1.5 mt-3">
                {customerTypeData.map((d) => (
                  <div key={d.name} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span style={{ width: 9, height: 9, borderRadius: 999, background: d.color }} />
                      <span style={{ color: ink }}>{d.name}</span>
                    </div>
                    <span style={{ color: inkSoft }}>{d.value} งาน ({Math.round(d.value / (totalCancelledJobs || 1) * 100)}%)</span>
                  </div>
                ))}
              </div>
              {selectedCustomerType && (
                <DetailList
                  title={`ตัวอย่างงานที่ยกเลิก · ${selectedCustomerType}`}
                  onClose={() => setSelectedCustomerType(null)}
                  loading={detailLoading.customerType}
                  rows={detailRows.customerType}
                  columns={[{ key: "eventName", label: "ชื่องาน" }, { key: "jobType", label: "ประเภทงาน" }, { key: "reason", label: "เหตุผล" }, { key: "sales", label: "Sales" }]}
                />
              )}
            </Card>

            <Card>
              <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold mb-4">งานยกเลิกตามประเภทงาน</p>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={jobTypeCancelData} layout="vertical" margin={{ left: 8 }}>
                  <CartesianGrid stroke={line} horizontal={false} />
                  <XAxis type="number" tick={{ fill: inkFaint, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fill: ink, fontSize: 12 }} axisLine={false} tickLine={false} width={70} />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                  <Bar dataKey="value" name="จำนวนงาน" fill={chartBlue} radius={[0, 4, 4, 0]} cursor="pointer"
                    onClick={(d) => setSelectedJobTypeCancel((prev) => (prev === d.name ? null : d.name))}
                  />
                </BarChart>
              </ResponsiveContainer>
              {selectedJobTypeCancel && (
                <DetailList
                  title={`ตัวอย่างงานที่ยกเลิก · ${selectedJobTypeCancel}`}
                  onClose={() => setSelectedJobTypeCancel(null)}
                  loading={detailLoading.jobType}
                  rows={detailRows.jobType}
                  columns={[{ key: "eventName", label: "ชื่องาน" }, { key: "customerType", label: "ประเภทลูกค้า" }, { key: "reason", label: "เหตุผล" }, { key: "sales", label: "Sales" }]}
                />
              )}
            </Card>

            <Card>
              <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold mb-4">สาเหตุการยกเลิก (เรียงจากมากไปน้อย)</p>
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${line}` }}>
                    <th style={{ color: inkFaint }} className="text-left font-normal py-1.5 text-xs">#</th>
                    <th style={{ color: inkFaint }} className="text-left font-normal py-1.5 text-xs">สาเหตุการยกเลิก</th>
                    <th style={{ color: inkFaint }} className="text-right font-normal py-1.5 text-xs">จำนวน</th>
                    <th style={{ color: inkFaint }} className="text-right font-normal py-1.5 text-xs">%</th>
                  </tr>
                </thead>
                <tbody>
                  {cancelReasons.map((r, i) => (
                    <tr key={r.reason} style={{ borderBottom: i < cancelReasons.length - 1 ? `1px solid ${line}` : "none" }}>
                      <td className="py-2">
                        <span style={{ background: bgApp, color: inkSoft, borderRadius: 999, width: 20, height: 20 }} className="text-xs inline-flex items-center justify-center">{i + 1}</span>
                      </td>
                      <td style={{ color: ink }} className="py-2">{r.reason}</td>
                      <td style={{ color: ink }} className="py-2 text-right">{r.count}</td>
                      <td style={{ color: inkSoft }} className="py-2 text-right">{Math.round(r.count / totalReasons * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>

          {/* Row 4: recent files / data quality / notifications */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card>
              <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold mb-4">ข้อมูลไฟล์ล่าสุด</p>
              <div className="flex flex-col gap-2">
                {uploadHistory.slice(0, 2).map((h) => (
                  <div key={h.id} style={{ border: `1px solid ${line}`, borderRadius: 10 }} className="flex items-center gap-3 p-3">
                    <div style={{ background: h.type === "Cancelled" ? kpi1IconBg : kpi4IconBg, borderRadius: 8 }} className="w-9 h-9 flex items-center justify-center shrink-0">
                      {h.type === "Cancelled"
                        ? <FileSpreadsheet size={16} style={{ color: redText }} />
                        : <FileText size={16} style={{ color: navyPrimary }} />}
                    </div>
                    <div className="min-w-0">
                      <p style={{ color: ink }} className="text-xs font-medium truncate">{h.fileName}</p>
                      <p style={{ color: inkFaint }} className="text-[11px]">{h.uploadedAt} · {h.rows.toLocaleString()} รายการ</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold mb-4">คุณภาพข้อมูล</p>
              <div className="flex flex-col gap-2.5 text-sm">
                <div className="flex items-center gap-2">
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: chartBlue }} />
                  <span style={{ color: inkSoft }}>อ่านข้อมูลทั้งหมด</span>
                  <span style={{ color: ink }} className="ml-auto font-medium">{(dataQuality?.totalRead ?? 0).toLocaleString()} รายการ</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={13} style={{ color: green }} />
                  <span style={{ color: inkSoft }}>อ่านสำเร็จ</span>
                  <span style={{ color: ink }} className="ml-auto font-medium">{(dataQuality?.successRead ?? 0).toLocaleString()} รายการ ({dataQuality?.successPct ?? 0}%)</span>
                </div>
                <div className="flex items-center gap-2">
                  <AlertCircle size={13} style={{ color: yellow }} />
                  <span style={{ color: inkSoft }}>ข้อมูลไม่สมบูรณ์</span>
                  <span style={{ color: ink }} className="ml-auto font-medium">{(dataQuality?.incomplete ?? 0).toLocaleString()} รายการ ({dataQuality?.incompletePct ?? 0}%)</span>
                </div>
              </div>
            </Card>

            <Card style={{ background: "#EFF6FF", borderColor: "#DCE9FB" }}>
              <div className="flex items-start gap-3">
                <div style={{ background: "#DCE9FB", borderRadius: 8 }} className="w-9 h-9 flex items-center justify-center shrink-0">
                  <Bell size={16} style={{ color: navyPrimary }} />
                </div>
                <div>
                  <p style={{ color: ink, fontFamily: FONT }} className="text-sm font-semibold mb-1">การแจ้งเตือน</p>
                  <p style={{ color: inkSoft }} className="text-xs">
                    แจ้งเตือน: กรุณาอัปโหลดไฟล์ Calendar และ Cancelled ประจำสัปดาห์เข้าสู่ระบบทุกวันเสาร์ เวลา 09:00 น.
                  </p>
                </div>
              </div>
            </Card>
          </div>
          </>
          )}
        </div>
      </div>

      {toast && (
        <div style={{ background: ink, color: "#fff", fontFamily: FONT }} className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-lg text-sm shadow-xl z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
