// API client สำหรับ sales_summary_dashboard.jsx <-> backend FastAPI (ดู backend/README.md)
// Auth เป็น demo token คงที่ต่อ role (ยังไม่มีระบบ login จริง — ดู backend/app/auth.py)

export const API_BASE =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_API_BASE) ||
  "http://localhost:8000";

const DEMO_TOKENS = {
  sales: "sales-demo-token",
  manager: "manager-demo-token",
  executive: "executive-demo-token",
};

function qs(params) {
  const usp = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") usp.set(k, v);
  });
  const s = usp.toString();
  return s ? `?${s}` : "";
}

async function apiFetch(path, { role, ...opts } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${DEMO_TOKENS[role] || DEMO_TOKENS.sales}`,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail || ""; } catch { /* body ไม่ใช่ json */ }
    throw new Error(detail || `${path} ล้มเหลว (HTTP ${res.status})`);
  }
  return res;
}

async function getJSON(path, role) {
  const res = await apiFetch(path, { role });
  return res.json();
}

export function api(role) {
  return {
    me: () => getJSON("/auth/me", role),

    kpi: (from, to) => getJSON(`/summary/kpi${qs({ from, to })}`, role),
    cancellations: (from, to) => getJSON(`/summary/cancellations${qs({ from, to })}`, role),
    jobStatus: (from, to) => getJSON(`/summary/job-status${qs({ from, to })}`, role),
    paxBins: (from, to) => getJSON(`/summary/pax-bins${qs({ from, to })}`, role),
    manpowerCalendar: (from, to) => getJSON(`/summary/manpower-calendar${qs({ from, to })}`, role),
    events: (filters) => getJSON(`/events${qs(filters)}`, role),

    uploadHistory: () => getJSON("/uploads/history", role),
    uploadStatus: (jobId) => getJSON(`/uploads/${jobId}/status`, role),
    driveStatus: () => getJSON("/drive/status", role),

    async upload(fileList) {
      const form = new FormData();
      Array.from(fileList).forEach((f) => form.append("files", f));
      const res = await apiFetch("/uploads", { role, method: "POST", body: form });
      return res.json();
    },

    async downloadReport(format, from, to) {
      const res = await apiFetch(`/reports/export${qs({ format, from, to })}`, { role });
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : `report.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  };
}

// poll GET /uploads/{jobId}/status ทุก 1.5s จนกว่าจะ done/failed ตาม api_schema.md
export function pollUploadStatus(role, jobId, onUpdate, intervalMs = 1500) {
  let stopped = false;
  async function tick() {
    if (stopped) return;
    try {
      const status = await api(role).uploadStatus(jobId);
      onUpdate(status);
      if (status.status === "processing") {
        setTimeout(tick, intervalMs);
      }
    } catch (err) {
      if (!stopped) onUpdate({ status: "failed", error: err.message });
    }
  }
  tick();
  return () => { stopped = true; };
}
