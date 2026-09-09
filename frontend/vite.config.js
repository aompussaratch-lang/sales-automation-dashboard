import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite proxy backend paths ให้ frontend เรียก API แบบ relative path (same-origin) ได้เสมอ
// ไม่ว่าจะเปิดผ่าน localhost, LAN IP, หรือ Replit — proxy ทำงานฝั่ง Vite dev server เอง
// จึงไม่ขึ้นกับว่า browser เปิดหน้าเว็บผ่าน hostname ไหน (แก้ปัญหาที่เจอบน Replit)
const BACKEND = "http://localhost:8000";
const PROXY_PATHS = ["/auth", "/uploads", "/drive", "/summary", "/reports", "/events", "/function-sheet"];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5000,
    host: "0.0.0.0",
    proxy: Object.fromEntries(PROXY_PATHS.map((p) => [p, { target: BACKEND, changeOrigin: true }])),
  },
});
