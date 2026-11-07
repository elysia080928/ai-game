"""SQLite 连接与表结构。单进程、单连接，所有写操作由调用方持锁。"""

import os
import pathlib
import sqlite3
import threading

DATA_DIR = pathlib.Path(os.environ.get("DATA_DIR", "data")).resolve()
DB_PATH = DATA_DIR / "game.db"
LOCK = threading.RLock()
_conn = None


def init():
    global _conn
    if _conn is not None:
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS saves (
            user_id INTEGER PRIMARY KEY,
            state TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at REAL NOT NULL
        );
        """
    )
    _conn.commit()


def conn():
    if _conn is None:
        init()
    return _conn
