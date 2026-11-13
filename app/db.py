"""SQLite 连接与表结构。单进程、单连接，所有写操作由调用方持锁。"""

import os
import pathlib
import sqlite3
import threading

DATA_DIR = pathlib.Path(os.environ.get("DATA_DIR", "data")).resolve()
DB_PATH = DATA_DIR / "game.db"
SCHEMA_VERSION = 2
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
    version = _conn.execute("PRAGMA user_version").fetchone()[0]
    if version > SCHEMA_VERSION:
        raise RuntimeError("数据库版本高于当前程序版本")
    _conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at REAL NOT NULL,
            recent_slot INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at REAL NOT NULL,
            active_slot INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS saves (
            user_id INTEGER PRIMARY KEY,
            state TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS save_backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            slot_id INTEGER NOT NULL DEFAULT 1,
            state TEXT NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS battles (
            user_id INTEGER PRIMARY KEY,
            state TEXT NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS save_slots (
            user_id INTEGER NOT NULL,
            slot_id INTEGER NOT NULL CHECK(slot_id BETWEEN 1 AND 3),
            state TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at REAL NOT NULL,
            PRIMARY KEY(user_id, slot_id)
        );
        CREATE TABLE IF NOT EXISTS battle_slots (
            user_id INTEGER NOT NULL,
            slot_id INTEGER NOT NULL CHECK(slot_id BETWEEN 1 AND 3),
            state TEXT NOT NULL,
            updated_at REAL NOT NULL,
            PRIMARY KEY(user_id, slot_id)
        );
        """
    )
    columns = {
        "users": {row[1] for row in _conn.execute("PRAGMA table_info(users)")},
        "sessions": {row[1] for row in _conn.execute("PRAGMA table_info(sessions)")},
        "save_backups": {row[1] for row in _conn.execute("PRAGMA table_info(save_backups)")},
    }
    if "recent_slot" not in columns["users"]:
        _conn.execute("ALTER TABLE users ADD COLUMN recent_slot INTEGER NOT NULL DEFAULT 1")
    if "active_slot" not in columns["sessions"]:
        _conn.execute("ALTER TABLE sessions ADD COLUMN active_slot INTEGER NOT NULL DEFAULT 1")
    if "slot_id" not in columns["save_backups"]:
        _conn.execute("ALTER TABLE save_backups ADD COLUMN slot_id INTEGER NOT NULL DEFAULT 1")
    if version < SCHEMA_VERSION:
        _conn.execute("BEGIN IMMEDIATE")
        _conn.execute(
            """INSERT OR IGNORE INTO save_slots(user_id, slot_id, state, revision, updated_at)
            SELECT user_id, 1, state, revision, updated_at FROM saves"""
        )
        _conn.execute(
            """INSERT OR IGNORE INTO battle_slots(user_id, slot_id, state, updated_at)
            SELECT user_id, 1, state, updated_at FROM battles"""
        )
        _conn.execute("DELETE FROM saves")
        _conn.execute("DELETE FROM battles")
        _conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        _conn.commit()
    _conn.commit()


def conn():
    if _conn is None:
        init()
    return _conn
