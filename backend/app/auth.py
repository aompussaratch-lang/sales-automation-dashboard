"""
Auth แบบ demo — ตรวจ role จาก Bearer token ฝั่ง backend จริง (ไม่ใช่แค่ซ่อนปุ่มฝั่ง frontend)
ตาม api_schema.md หัวข้อ 1

⚠️ นี่คือ token คงที่สำหรับ dev/demo เท่านั้น ก่อนขึ้น production ต้องเปลี่ยนเป็นระบบ auth จริง
   (เช่น JWT ที่ออกจาก login endpoint จริง + เก็บ user ใน database)
"""

from fastapi import Depends, Header, HTTPException, status

DEMO_USERS = {
    "sales-demo-token": {"id": "u_1023", "name": "สมชาย ใจดี", "role": "sales"},
    "manager-demo-token": {"id": "u_2001", "name": "หัวหน้าฝ่ายขาย", "role": "manager"},
    "executive-demo-token": {"id": "u_3001", "name": "ผู้บริหาร", "role": "executive"},
}


def get_current_user(authorization: str = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="ต้องแนบ Authorization: Bearer <token>")
    token = authorization.removeprefix("Bearer ").strip()
    user = DEMO_USERS.get(token)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="token ไม่ถูกต้อง")
    return user


def require_roles(*roles: str):
    """Dependency factory: ใช้เป็น Depends(require_roles('sales')) ใน route เพื่อบังคับสิทธิ์ฝั่ง backend"""

    def dependency(user: dict = Depends(get_current_user)) -> dict:
        if user["role"] not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"role '{user['role']}' ไม่มีสิทธิ์ทำรายการนี้")
        return user

    return dependency
