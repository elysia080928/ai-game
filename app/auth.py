"""密码哈希、会话与基础限流。"""

import base64
import hashlib
import hmac
import secrets
import threading
import time

from fastapi import HTTPException

from . import db

SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
SESSION_TTL = 7 * 24 * 3600
COOKIE_NAME = "session"

_rate_lock = threading.Lock()
_rate_hits = {}


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_DKLEN
    )
    return "scrypt${}${}${}${}${}".format(
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        base64.b64encode(salt).decode(),
        base64.b64encode(digest).decode(),
    )


def verify_password(password, stored):
    try:
        algorithm, n, r, p, salt_b64, digest_b64 = stored.split("$")
        if algorithm != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        digest = hashlib.scrypt(
            password.encode("utf-8"), salt=salt, n=int(n), r=int(r), p=int(p), dklen=len(expected)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest, expected)


def token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(user_id):
    token = secrets.token_urlsafe(32)
    now = time.time()
    with db.LOCK:
        conn = db.conn()
        user = conn.execute("SELECT recent_slot FROM users WHERE id = ?", (user_id,)).fetchone()
        slot = user["recent_slot"] if user else 1
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        conn.execute(
            "INSERT INTO sessions(token_hash, user_id, expires_at, active_slot) VALUES (?, ?, ?, ?)",
            (token_hash(token), user_id, now + SESSION_TTL, slot),
        )
        conn.commit()
    return token


def set_session_slot(token, slot):
    with db.LOCK:
        conn = db.conn()
        row = conn.execute(
            "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at >= ?",
            (token_hash(token), time.time()),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="登录已过期")
        conn.execute("UPDATE sessions SET active_slot = ? WHERE token_hash = ?", (slot, token_hash(token)))
        conn.execute("UPDATE users SET recent_slot = ? WHERE id = ?", (slot, row["user_id"]))
        conn.commit()


def delete_session(token):
    with db.LOCK:
        conn = db.conn()
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
        conn.commit()


def user_from_request(request):
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    with db.LOCK:
        conn = db.conn()
        row = conn.execute(
            "SELECT user_id, expires_at, active_slot FROM sessions WHERE token_hash = ?", (token_hash(token),)
        ).fetchone()
        if row is None or row["expires_at"] < time.time():
            return None
        user = conn.execute("SELECT id, username FROM users WHERE id = ?", (row["user_id"],)).fetchone()
    if user is None:
        return None
    return {
        "id": user["id"], "username": user["username"], "slot": row["active_slot"],
        "session_token": token,
    }


def rate_limit(key, limit, window):
    now = time.time()
    with _rate_lock:
        hits = [t for t in _rate_hits.get(key, []) if now - t < window]
        if len(hits) >= limit:
            raise HTTPException(status_code=429, detail="操作过于频繁，请稍后再试")
        hits.append(now)
        _rate_hits[key] = hits
        if len(_rate_hits) > 5000:
            stale = [
                stale_key
                for stale_key, stamps in _rate_hits.items()
                if not stamps or now - stamps[-1] >= 3600
            ]
            for stale_key in stale:
                _rate_hits.pop(stale_key, None)
            while len(_rate_hits) > 5000:
                _rate_hits.pop(next(iter(_rate_hits)))
