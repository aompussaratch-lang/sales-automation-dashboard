#!/usr/bin/env bash
# รันทั้ง backend (FastAPI) และ frontend (Vite) พร้อมกัน — ใช้สำหรับ Replit หรือเครื่องอื่นที่มี Python+Node
set -e

echo "=== ติดตั้ง/รัน backend (FastAPI) ==="
cd backend
python3 -m venv .venv 2>/dev/null || true
source .venv/bin/activate
unset PIP_USER  # Replit ตั้ง PIP_USER=1 เป็นค่าเริ่มต้น ขัดกับการ install ใน venv
pip install -q -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!
cd ..

echo "=== ติดตั้ง/รัน frontend (Vite) ==="
cd frontend
npm install --silent
npm run dev -- --host 0.0.0.0 --port 5000 &
FRONTEND_PID=$!
cd ..

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
