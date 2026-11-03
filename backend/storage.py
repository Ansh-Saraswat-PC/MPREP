import json
import sqlite3
from contextlib import closing
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "data" / "evaluations.sqlite3"


def connect():
    return sqlite3.connect(DB_PATH, timeout=10)


def initialize():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with closing(connect()) as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS evaluations (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                payload TEXT NOT NULL
            )
        """)
        connection.commit()


def save(run):
    payload = json.dumps(run)

    with closing(connect()) as connection:
        connection.execute(
            """
            INSERT INTO evaluations (id, created_at, payload)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
            """,
            (run["id"], run["created_at"], payload),
        )
        connection.commit()


def get(run_id):
    with closing(connect()) as connection:
        row = connection.execute(
            "SELECT payload FROM evaluations WHERE id = ?",
            (run_id,),
        ).fetchone()

    return json.loads(row[0]) if row else None


def recent(limit=100):
    with closing(connect()) as connection:
        rows = connection.execute(
            """
            SELECT payload FROM evaluations
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return [json.loads(row[0]) for row in rows]


def all_runs():
    with closing(connect()) as connection:
        rows = connection.execute(
            "SELECT payload FROM evaluations"
        ).fetchall()

    return [json.loads(row[0]) for row in rows]