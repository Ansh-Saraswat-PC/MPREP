import asyncio
import json
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import storage


FINAL = {"completed", "cancelled", "failed"}
STAGES = ("Initialize", "Static analysis", "Model launch")

# Active execution handles only. Durable records live in SQLite.
active = {}

app = FastAPI()

# 2. Configure CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 3. Define routes AFTER app is created
@app.get("/")
def read_root():
    return {"message": "Comprehensive Model Analysis API is running"}
def timestamp():
    return datetime.now(timezone.utc).isoformat()


def add_log(run, message, level="INFO"):
    run["logs"].append({
        "time": timestamp(),
        "level": level,
        "message": message,
    })
    run["revision"] += 1


def finish(run, status, message, level="INFO"):
    run["status"] = status
    run["finished_at"] = timestamp()

    for stage in run["stages"]:
        if stage["status"] == "running":
            stage["status"] = (
                "cancelled" if status == "cancelled" else "failed"
            )
        elif stage["status"] == "pending":
            stage["status"] = "skipped"

    add_log(run, message, level)


async def persist(run):
    # Freeze the document before passing it to another thread.
    document = json.loads(json.dumps(run))
    await asyncio.to_thread(storage.save, document)


async def execute(run):
    started = time.monotonic()

    async def publish(message, level="INFO"):
        run["elapsed"] = round(time.monotonic() - started, 2)
        add_log(run, message, level)
        await persist(run)

    try:
        run["status"] = "running"
        run["started_at"] = timestamp()
        await publish("Simulation started. No model is executed.")

        delay = 0.8 if run["profile"] == "quick" else 1.5

        for stage in run["stages"]:
            stage["status"] = "running"
            stage_started = time.monotonic()
            await publish(f"{stage['name']}: simulation started.")

            # Cooperative cancellation: database writes are never interrupted.
            try:
                await asyncio.wait_for(
                    active[run["id"]]["stop"].wait(),
                    timeout=delay,
                )
            except asyncio.TimeoutError:
                pass

            stage["duration"] = round(
                time.monotonic() - stage_started, 2
            )
            run["elapsed"] = round(time.monotonic() - started, 2)

            if active[run["id"]]["stop"].is_set():
                reason = active[run["id"]]["reason"]
                status = "cancelled" if reason == "user" else "failed"
                finish(
                    run,
                    status,
                    "Cancelled by user."
                    if reason == "user"
                    else "Interrupted by backend shutdown.",
                    "WARN",
                )
                await persist(run)
                return

            stage["status"] = "passed"
            await publish(f"{stage['name']}: simulated pass.")

        run["score"] = 92
        run["status"] = "completed"
        run["finished_at"] = timestamp()
        await publish(
            "Complete. Score 92/100 and memory 184 MB are "
            "simulated fixtures, not measurements."
        )

    except Exception:
        run["elapsed"] = round(time.monotonic() - started, 2)
        finish(run, "failed", "Internal evaluation error.", "ERROR")
        await persist(run)

    finally:
        active.pop(run["id"], None)


@asynccontextmanager
async def lifespan(app):
    await asyncio.to_thread(storage.initialize)

    # A previous process may have stopped without finalizing its runs.
    previous_runs = await asyncio.to_thread(storage.all_runs)
    for run in previous_runs:
        if run["status"] not in FINAL:
            finish(
                run,
                "failed",
                "Previous backend process stopped before completion. "
                "Rerun to evaluate again.",
                "ERROR",
            )
            await persist(run)

    yield

    jobs = list(active.values())
    for job in jobs:
        job["reason"] = "shutdown"
        job["stop"].set()

    await asyncio.gather(
        *(job["task"] for job in jobs),
        return_exceptions=True,
    )


app = FastAPI(
    title="CMA Persistent Evaluation Demo",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class EvaluationInput(BaseModel):
    project: str = Field(min_length=1, max_length=80)
    profile: Literal["quick", "standard"] = "standard"
    notes: str = Field(default="", max_length=500)


async def require_run(run_id):
    run = await asyncio.to_thread(storage.get, run_id)
    if run is None:
        raise HTTPException(404, "Evaluation not found.")
    return run


@app.get("/ready")
async def ready():
    await asyncio.to_thread(storage.recent, 1)
    return {
        "status": "ready",
        "mode": "simulation",
        "storage": "sqlite",
    }


@app.get("/evaluations")
async def list_evaluations(
    limit: int = Query(default=30, ge=1, le=100),
):
    return await asyncio.to_thread(storage.recent, limit)


@app.post("/evaluations", status_code=201)
async def create_evaluation(body: EvaluationInput):
    project = body.project.strip()
    if not project:
        raise HTTPException(422, "Project name cannot be blank.")

    if len(active) >= 4:
        raise HTTPException(429, "At most four evaluations can run at once.")

    run_id = str(uuid4())
    run = {
        "id": run_id,
        "project": project,
        "profile": body.profile,
        "notes": body.notes,
        "created_at": timestamp(),
        "started_at": None,
        "finished_at": None,
        "status": "queued",
        "score": None,
        "elapsed": 0.0,
        "simulated": True,
        "revision": 0,
        "stages": [
            {"name": name, "status": "pending", "duration": None}
            for name in STAGES
        ],
        "logs": [],
    }

    # Reserve a slot before awaiting persistence.
    job = {
        "stop": asyncio.Event(),
        "reason": "user",
        "task": None,
    }
    active[run_id] = job

    try:
        await persist(run)
    except Exception:
        active.pop(run_id, None)
        raise

    job["task"] = asyncio.create_task(execute(run))
    return run


@app.get("/evaluations/{run_id}")
async def read_evaluation(run_id: str):
    return await require_run(run_id)


@app.get("/evaluations/{run_id}/logs")
async def stream_evaluation(run_id: str):
    await require_run(run_id)

    async def events():
        last_revision = -1

        while True:
            run = await asyncio.to_thread(storage.get, run_id)
            if run is None:
                return

            if run["revision"] != last_revision:
                last_revision = run["revision"]
                yield json.dumps(run) + "\n"

            if run["status"] in FINAL:
                return

            await asyncio.sleep(0.25)

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/evaluations/{run_id}/cancel")
async def cancel_evaluation(run_id: str):
    run = await require_run(run_id)

    if run["status"] in FINAL:
        return run

    job = active.get(run_id)
    if job is None or job["task"] is None:
        raise HTTPException(
            409,
            "No active execution handle. Refresh the evaluation status.",
        )

    job["reason"] = "user"
    job["stop"].set()

    # A disconnected HTTP client must not cancel the evaluation task.
    await asyncio.shield(job["task"])
    return await require_run(run_id)