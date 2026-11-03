type Run = {
  id: string;
  project: string;
  profile: "quick" | "standard";
  notes: string;
  created_at: string;
  status: string;
  revision?: number;
  score: number | null;
  elapsed: number;
  simulated: boolean;
  stages: {
    name: string;
    status: string;
    duration: number | null;
  }[];
  logs: {
    time: string;
    level: string;
    message: string;
  }[];
};

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const input = (id: string) => $<HTMLInputElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);
const api = (
  import.meta.env.PUBLIC_API_BASE_URL ?? "http://localhost:8000"
).replace(/\/+$/, "");

const key = "cma-history-v1";
const finalStates = new Set(["completed", "cancelled", "failed"]);

let selected: Run | null = null;
let history: Run[] = [];
let stream: AbortController | null = null;
let creating = false;

function notice(text: string) {
  $("notice").textContent = text;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function unfinished(run: Run) {
  return !finalStates.has(run.status);
}

try {
  const stored = JSON.parse(localStorage.getItem(key) ?? "[]");
  if (Array.isArray(stored)) {
    // Ignore records that don't have the fields this UI requires.
    history = stored.filter(
      (r) =>
        r &&
        typeof r.id === "string" &&
        typeof r.project === "string" &&
        typeof r.created_at === "string" &&
        typeof r.status === "string" &&
        typeof r.elapsed === "number" &&
        Array.isArray(r.logs) &&
        Array.isArray(r.stages),
    ).slice(0, 30);
  }
} catch {
  notice("Local history could not be loaded.");
}

function saveHistory() {
  try {
    localStorage.setItem(key, JSON.stringify(history));
  } catch {
    notice("Browser storage unavailable or full; history is session-only.");
  }
}

function remember(run: Run) {
  const existing = history.find((item) => item.id === run.id);

  if (
    existing &&
    (existing.revision ?? -1) > (run.revision ?? -1)
  ) {
    return;
  }

  history = [
    run,
    ...history.filter((item) => item.id !== run.id),
  ]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 30);

  saveHistory();
  renderHistory();
}

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${api}${path}`, {
    cache: "no-store",
    ...options,
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // Keep the HTTP status if the response isn't JSON.
    }
    throw new Error(detail);
  }

  return response;
}

function logText(run: Run) {
  return run.logs.map((log) =>
    `${new Date(log.time).toLocaleTimeString()}  ${log.level.padEnd(5)}  ${log.message}`,
  ).join("\n");
}

function renderLogs() {
  const query = input("log-search").value.toLowerCase();
  const text = selected ? logText(selected) : "";
  $("terminal").textContent = text
    ? text.split("\n").filter((line) =>
        line.toLowerCase().includes(query),
      ).join("\n") || "No matching logs."
    : "Waiting for deployment...";

  if (input("autoscroll").checked) {
    $("terminal").scrollTop = $("terminal").scrollHeight;
  }
}

function renderRun() {
    publishWorkspaceState();
  if (!selected) return;

  $("run-title").textContent = selected.project;
  $("run-id").textContent =
    `${selected.id} · ${selected.profile} · ${selected.notes || "No notes"}`;
  $("status").textContent = selected.status;
  $("score").textContent =
    selected.score === null ? "—" : `${selected.score} / 100`;
  $("duration").textContent = `${selected.elapsed.toFixed(1)}s`;

  button("cancel").disabled = !unfinished(selected);
  button("reconnect").disabled = !unfinished(selected);
  button("rerun").disabled = creating;

  const stages = selected.stages.map((stage) => {
    const item = document.createElement("li");
    item.dataset.state = stage.status;

    const title = document.createElement("strong");
    title.textContent = stage.name;

    const detail = document.createElement("span");
    detail.textContent = stage.status +
      (stage.duration === null ? "" : ` · ${stage.duration}s`);

    item.append(title, detail);
    return item;
  });

  $("stages").replaceChildren(...stages);
  renderLogs();
}

function renderHistory() {
    publishWorkspaceState();
  const query = input("history-search").value.toLowerCase();
  const status = $<HTMLSelectElement>("history-filter").value;
  const body = $("history");
  body.replaceChildren();

  const matches = history.filter((run) =>
    `${run.project} ${run.id}`.toLowerCase().includes(query) &&
    (!status || run.status === status),
  );

  for (const run of matches) {
    const row = document.createElement("tr");
    const project = document.createElement("td");
    const open = document.createElement("button");
    open.className = "history-link";
    open.textContent = `${run.project} / ${run.id.slice(0, 8)}`;
    open.addEventListener("click", () => selectRun(run));
    project.append(open);
    row.append(project);

    for (const value of [
      new Date(run.created_at).toLocaleString(),
      run.status,
      run.score === null ? "—" : String(run.score),
      `${run.elapsed.toFixed(1)}s`,
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }

  if (!matches.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No evaluations to display.";
    row.append(cell);
    body.append(row);
  }
}

function accept(run: Run) {
  selected = run;
  remember(run);
  renderRun();
}

async function watch(id: string) {
  stream?.abort();
  const controller = new AbortController();
  stream = controller;

  try {
    const response = await request(`/evaluations/${id}/logs`, {
      signal: controller.signal,
    });
    if (!response.body) throw new Error("Streaming is unavailable.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    function consume(line: string) {
      if (controller.signal.aborted || !line.trim()) return;
      const run: Run = JSON.parse(line);
      if (run.id !== id) throw new Error("Unexpected run ID in stream.");
      accept(run);
    }

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (controller.signal.aborted) return;

        pending += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });

        // Network chunks need not end at a JSON record boundary.
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }

        if (done) {
          consume(pending);
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (selected?.id === id && unfinished(selected)) {
      throw new Error("Stream ended before a final status was received.");
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      notice(
        `Live connection unavailable: ${errorText(error)} ` +
        "Showing last received state. The job was not marked failed. " +
        "Use Reconnect to check again.",
      );
    }
  } finally {
    if (stream === controller) stream = null;
  }
}

function selectRun(run: Run) {
  stream?.abort();
  selected = run;
  renderRun();
  notice(
    unfinished(run)
      ? "Reconnecting to the last known active evaluation..."
      : "Showing saved evaluation results.",
  );
  if (unfinished(run)) void watch(run.id);
}

async function start(config: {
  project: string;
  profile: string;
  notes: string;
}) {
  if (creating) return;
  creating = true;
  button("deploy").disabled = true;
  button("rerun").disabled = true;
  notice("Creating evaluation...");

  try {
    const response = await request("/evaluations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const run: Run = await response.json();
    stream?.abort();
    accept(run);
window.dispatchEvent(new Event("cma:created"));
notice(`Evaluation ${run.id.slice(0, 8)} created.`);
    void watch(run.id);
  } catch (error) {
    notice(`Could not create evaluation: ${errorText(error)}`);
  } finally {
    creating = false;
    button("deploy").disabled = false;
    button("rerun").disabled = !selected;
  }
}

$("evaluation-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const project = input("project").value.trim();
  if (!project) {
    notice("Enter a project name.");
    return;
  }
  void start({
    project,
    profile: $<HTMLSelectElement>("profile").value,
    notes: input("notes").value.trim(),
  });
});

button("rerun").addEventListener("click", () => {
  if (selected) {
    void start({
      project: selected.project,
      profile: selected.profile,
      notes: selected.notes,
    });
  }
});

button("reconnect").addEventListener("click", () => {
  if (selected) {
    notice("Reconnecting...");
    void watch(selected.id);
  }
});

button("cancel").addEventListener("click", async () => {
  if (!selected) return;
  const id = selected.id;
  button("cancel").disabled = true;

  try {
    const response = await request(`/evaluations/${id}/cancel`, {
      method: "POST",
    });
    const run: Run = await response.json();
    remember(run);

    if (selected?.id === id) {
      // Stop any older buffered snapshots replacing this final state.
      stream?.abort();
      accept(run);
    }
    notice(`Evaluation ${id.slice(0, 8)} is ${run.status}.`);
  } catch (error) {
    notice(`Cancellation not confirmed: ${errorText(error)}`);
    if (selected?.id === id) renderRun();
  }
});

async function checkConnection() {
  button("connection").disabled = true;
  button("connection").textContent = "Checking...";
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);

  try {
    await request("/ready", { signal: controller.signal });
    button("connection").textContent =
      `● Reachable · ${new Date().toLocaleTimeString()}`;
  } catch {
    button("connection").textContent = "○ Unreachable · Retry";
  } finally {
    clearTimeout(timeout);
    button("connection").disabled = false;
  }
}

button("connection").addEventListener("click", () => void checkConnection());

input("log-search").addEventListener("input", renderLogs);
input("autoscroll").addEventListener("change", renderLogs);
input("history-search").addEventListener("input", renderHistory);
$("history-filter").addEventListener("change", renderHistory);

button("copy").addEventListener("click", async () => {
  if (!selected) return notice("Select an evaluation first.");
  try {
    await navigator.clipboard.writeText(logText(selected));
    notice("All received logs copied.");
  } catch {
    notice("Clipboard unavailable. Use Logs ↓ instead.");
  }
});

function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

button("download").addEventListener("click", () => {
  if (!selected) return notice("Select an evaluation first.");
  download(logText(selected), `${selected.id}.txt`, "text/plain");
});

button("report").addEventListener("click", () => {
  if (!selected) return notice("Select an evaluation first.");
  download(
    JSON.stringify({
      ...selected,
      exported_at: new Date().toISOString(),
      report_scope: "Last received simulation snapshot; not a real model evaluation.",
    }, null, 2),
    `${selected.id}.json`,
    "application/json",
  );
});

button("clear").addEventListener("click", () => {
  if (!confirm("Clear device history? Backend runs will not be cancelled.")) return;
  history = [];
  saveHistory();
  renderHistory();
  notice("Local history cleared. Further live updates will save the active run again.");
});

function publishWorkspaceState() {
  window.dispatchEvent(
    new CustomEvent("cma:state", {
      detail: {
        history,
        selected,
      },
    }),
  );
}

window.addEventListener("cma:request-state", publishWorkspaceState);

window.addEventListener("cma:open-run", (event) => {
  const id = (event as CustomEvent<string>).detail;
  const run = history.find((item) => item.id === id);
  if (run) selectRun(run);
});

renderHistory();

if (history[0]) {
  selectRun(history[0]);
}

void checkConnection();
void loadServerHistory();

async function loadServerHistory() {
  button("sync-history").disabled = true;

  try {
    const response = await request("/evaluations?limit=30");
    const records: Run[] = await response.json();

    if (!Array.isArray(records)) {
      throw new Error("Invalid history response.");
    }

    for (const run of records) {
      remember(run);
    }

    if (!selected && history[0]) {
      selectRun(history[0]);
    } else if (selected) {
      const refreshed = history.find(
        (run) => run.id === selected?.id,
      );

      if (
        refreshed &&
        (refreshed.revision ?? -1) >
          (selected.revision ?? -1)
      ) {
        selected = refreshed;
        renderRun();
      }
    }

    notice(`Loaded ${records.length} evaluations from server storage.`);
  } catch (error) {
    notice(
      `Could not load server history: ${errorText(error)}. ` +
      "Your device cache is still available.",
    );
  } finally {
    button("sync-history").disabled = false;
  }
}

button("sync-history").addEventListener(
  "click",
  () => void loadServerHistory(),
);