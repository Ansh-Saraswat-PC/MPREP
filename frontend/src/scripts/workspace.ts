type WorkspaceRun = {
  id: string;
  project: string;
  profile: string;
  notes: string;
  created_at: string;
  status: string;
  score: number | null;
  elapsed: number;
  simulated: boolean;
  stages: {
    name: string;
    status: string;
    duration: number | null;
  }[];
  logs: unknown[];
};

type WorkspaceState = {
  history: WorkspaceRun[];
  selected: WorkspaceRun | null;
};

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

let state: WorkspaceState = { history: [], selected: null };
let inspected: WorkspaceRun | null = null;

const main = document.querySelector("main")!;
const heading = document.querySelector<HTMLElement>(".heading")!;
const footer = main.querySelector("footer")!;

const formCard = el("evaluation-form").closest(".card")!;
const metrics = document.querySelector(".metrics")!;
const activity = document.querySelector(".activity")!;
const historyCard = el("history").closest(".card")!;

// Move existing elements rather than recreate them.
// Their existing listeners and IDs remain intact.
const workspace = document.createElement("div");
workspace.className = "workspace";

workspace.innerHTML = `
  <div class="workspace-navigation">
    <div class="workspace-tabs" role="tablist" aria-label="Workspace sections">
      <button id="tab-overview" role="tab" aria-controls="panel-overview"
        aria-selected="true">Overview</button>
      <button id="tab-evaluations" role="tab" aria-controls="panel-evaluations"
        aria-selected="false" tabindex="-1">Evaluations</button>
      <button id="tab-history" role="tab" aria-controls="panel-history"
        aria-selected="false" tabindex="-1">History</button>
      <button id="tab-reports" role="tab" aria-controls="panel-reports"
        aria-selected="false" tabindex="-1">Reports</button>
      <button id="tab-settings" role="tab" aria-controls="panel-settings"
        aria-selected="false" tabindex="-1">Settings</button>
    </div>
    <button id="new-evaluation">+ New evaluation</button>
  </div>

  <section id="panel-overview" role="tabpanel"
    aria-labelledby="tab-overview" tabindex="0">
    <div class="workspace-hero">
      <div>
        <p class="eyebrow">YOUR DEVELOPMENT WORKSPACE</p>
        <h2>Build with a clearer view.</h2>
        <p>Run evaluations, inspect pipeline activity, and keep a record of every result.</p>
      </div>
      <span class="hero-symbol" aria-hidden="true">◇</span>
    </div>

    <div class="overview-stats">
      <article class="card">
        <p class="eyebrow">LOADED EVALUATIONS</p>
        <strong id="total-runs">0</strong>
      </article>
      <article class="card">
        <p class="eyebrow">COMPLETED</p>
        <strong id="completed-runs">0</strong>
      </article>
      <article class="card">
        <p class="eyebrow">LAST KNOWN ACTIVE</p>
        <strong id="active-runs">0</strong>
      </article>
      <article class="card">
        <p class="eyebrow">AVERAGE SCORE · SIMULATED</p>
        <strong id="average-score">—</strong>
      </article>
    </div>

    <div class="overview-columns">
      <section class="card">
        <div class="section-heading">
          <h2>Recent evaluations</h2>
          <button id="view-history" class="secondary">View all →</button>
        </div>
        <div id="recent-runs"></div>
      </section>

      <section class="card workspace-info">
        <p class="eyebrow">ENVIRONMENT</p>
        <h2>Local development</h2>
        <dl>
          <div><dt>Analysis</dt><dd>Simulated</dd></div>
          <div><dt>Execution</dt><dd>In-process</dd></div>
          <div><dt>Persistence</dt><dd>SQLite backend</dd></div>
          <div><dt>Transport</dt><dd>HTTP stream</dd></div>
        </dl>
        <p class="muted">
          Statistics summarize up to 30 loaded records, not the entire database.
          Only the selected active run receives live updates.
        </p>
      </section>
    </div>
  </section>

  <section id="panel-evaluations" role="tabpanel"
    aria-labelledby="tab-evaluations" tabindex="0" hidden>
    <div class="panel-intro">
      <p class="muted">Selected evaluation · Live activity and received results</p>
      <button id="inspect-selected" class="secondary">Open details ↗</button>
    </div>
  </section>

  <section id="panel-history" role="tabpanel"
    aria-labelledby="tab-history" tabindex="0" hidden></section>

  <section id="panel-reports" role="tabpanel"
    aria-labelledby="tab-reports" tabindex="0" hidden>
    <div class="panel-intro">
      <div>
        <h2>Evaluation reports</h2>
        <p class="muted">Completed, failed, and cancelled runs from loaded history.</p>
      </div>
    </div>
    <div id="report-grid" class="report-grid"></div>
  </section>

  <section id="panel-settings" role="tabpanel"
    aria-labelledby="tab-settings" tabindex="0" hidden>
    <section class="card">
      <h2>Workspace preferences</h2>
      <p class="muted">Saved in this browser. These do not change backend behavior.</p>

      <label class="preference-row">
        <span>
          <strong>Compact layout</strong>
          <small>Reduce card and table spacing.</small>
        </span>
        <input id="compact-layout" type="checkbox" />
      </label>

      <label class="preference-row">
        <span>
          <strong>Background grid</strong>
          <small>Show the subtle workspace grid.</small>
        </span>
        <input id="show-grid" type="checkbox" checked />
      </label>

      <p id="preference-status" class="muted" role="status"></p>
    </section>

    <section class="card">
      <h2>Simulation boundaries</h2>
      <p class="muted">
        Scores and reported memory figures are fixtures.
        This workspace does not upload or execute model files,
        connect to Git repositories, or provide sandbox isolation.
      </p>
    </section>
  </section>
`;

main.insertBefore(workspace, footer);

el("panel-evaluations").append(metrics, activity);
el("panel-history").append(historyCard);

// New evaluation window.
const createDialog = document.createElement("dialog");
createDialog.id = "create-window";
createDialog.className = "workspace-dialog";
createDialog.setAttribute("aria-labelledby", "create-window-title");

createDialog.innerHTML = `
  <div class="window-heading">
    <div>
      <p class="eyebrow">NEW RUN</p>
      <h2 id="create-window-title">Create an evaluation</h2>
    </div>
    <button id="close-create" class="secondary" type="button"
      aria-label="Close new evaluation window">✕</button>
  </div>
  <p id="create-feedback" class="muted" role="status"></p>
`;

createDialog.append(formCard);
document.body.append(createDialog);

// Details window.
const detailsDialog = document.createElement("dialog");
detailsDialog.className = "workspace-dialog";
detailsDialog.setAttribute("aria-labelledby", "details-title");

detailsDialog.innerHTML = `
  <div class="window-heading">
    <div>
      <p class="eyebrow">EVALUATION SNAPSHOT</p>
      <h2 id="details-title">Run details</h2>
    </div>
    <button id="close-details" class="secondary" type="button"
      aria-label="Close evaluation details">✕</button>
  </div>
  <dl id="details-fields" class="details-fields"></dl>
  <p class="muted">This window shows the snapshot captured when opened.</p>
  <details class="raw-details">
    <summary>Raw report JSON</summary>
    <pre id="details-json"></pre>
  </details>
  <div class="window-actions">
    <button id="details-download" class="secondary">Download JSON ↓</button>
    <button id="details-open">Open evaluation →</button>
  </div>
`;

document.body.append(detailsDialog);

heading.querySelector("h1")!.textContent = "Your workspace";
heading.querySelector(".muted")!.textContent =
  "Evaluate models, explore results, and manage your development workflow.";

const tabs = Array.from(
  workspace.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
);

function showTab(name: string, focus = false) {
  for (const tab of tabs) {
    const active = tab.id === `tab-${name}`;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    el(tab.getAttribute("aria-controls")!).hidden = !active;
    if (active && focus) tab.focus();
  }
}

tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => {
    showTab(tab.id.replace("tab-", ""));
  });

  tab.addEventListener("keydown", (event) => {
    let target = index;

    if (event.key === "ArrowRight") target = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") {
      target = (index - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = tabs.length - 1;
    else return;

    event.preventDefault();
    showTab(tabs[target].id.replace("tab-", ""), true);
  });
});

function openRun(id: string) {
  window.dispatchEvent(new CustomEvent("cma:open-run", { detail: id }));
  showTab("evaluations", true);
}

function downloadReport(run: WorkspaceRun) {
  const data = {
    ...run,
    exported_at: new Date().toISOString(),
    report_scope: "Simulation snapshot; not a real model evaluation.",
  };

  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    }),
  );

  const link = document.createElement("a");
  link.href = url;
  link.download = `${run.id}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function inspect(run: WorkspaceRun) {
  inspected = run;
  el("details-title").textContent = run.project;
  el("details-json").textContent = JSON.stringify(run, null, 2);

  const fields = el("details-fields");
  fields.replaceChildren();

  const values = [
    ["Run ID", run.id],
    ["Status", run.status],
    ["Profile", run.profile],
    ["Created", new Date(run.created_at).toLocaleString()],
    ["Score · simulated", run.score === null ? "Unavailable" : `${run.score}/100`],
    ["Elapsed simulation", `${run.elapsed.toFixed(2)}s`],
    ["Notes", run.notes || "No notes"],
  ];

  for (const [label, value] of values) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    row.append(term, description);
    fields.append(row);
  }

  if (!detailsDialog.open) detailsDialog.showModal();
}

el("new-evaluation").addEventListener("click", () => {
  el("create-feedback").textContent = "";
  createDialog.showModal();
  el("project").focus();
});

el("close-create").addEventListener("click", () => createDialog.close());
el("close-details").addEventListener("click", () => detailsDialog.close());
el("view-history").addEventListener("click", () => showTab("history", true));

el("inspect-selected").addEventListener("click", () => {
  if (state.selected) inspect(state.selected);
});

el("details-download").addEventListener("click", () => {
  if (inspected) downloadReport(inspected);
});

el("details-open").addEventListener("click", () => {
  if (!inspected) return;
  detailsDialog.close();
  openRun(inspected.id);
});

window.addEventListener("cma:created", () => {
  createDialog.close();
  showTab("evaluations");
});

// Mirror existing creation errors into the modal.
// The original notice is outside the modal and otherwise inaccessible.
new MutationObserver(() => {
  if (createDialog.open) {
    el("create-feedback").textContent = el("notice").textContent;
  }
}).observe(el("notice"), {
  childList: true,
  characterData: true,
  subtree: true,
});

// Existing history buttons already select runs.
// Also switch to the evaluation tab when one is clicked.
el("history").addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest(".history-link")) showTab("evaluations", true);
});

function renderWorkspace() {
  const runs = state.history;
  const completed = runs.filter((run) => run.status === "completed");
  const scores = completed
    .map((run) => run.score)
    .filter((score): score is number => typeof score === "number");

  el("total-runs").textContent = String(runs.length);
  el("completed-runs").textContent = String(completed.length);
  el("active-runs").textContent = String(
    runs.filter((run) => ["queued", "running"].includes(run.status)).length,
  );
  el("average-score").textContent = scores.length
    ? (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(0)
    : "—";

  el<HTMLButtonElement>("inspect-selected").disabled = !state.selected;

  const recent = el("recent-runs");
  recent.replaceChildren();

  for (const run of runs.slice(0, 5)) {
    const row = document.createElement("button");
    row.className = "recent-run";

    const label = document.createElement("span");
    const name = document.createElement("strong");
    const id = document.createElement("small");

    name.textContent = run.project;
    id.textContent = `${run.id.slice(0, 8)} · ${run.profile}`;
    label.append(name, id);

    const status = document.createElement("span");
    status.className = "run-pill";
    status.dataset.status = run.status;
    status.textContent = run.status;

    row.append(label, status);
    row.addEventListener("click", () => openRun(run.id));
    recent.append(row);
  }

  if (!runs.length) {
    recent.textContent = "No evaluations yet. Create your first run above.";
  }

  const reports = el("report-grid");
  reports.replaceChildren();

  const finished = runs.filter((run) =>
    ["completed", "failed", "cancelled"].includes(run.status),
  );

  for (const run of finished) {
    const card = document.createElement("article");
    card.className = "card report-card";

    const label = document.createElement("p");
    label.className = "eyebrow";
    label.textContent = `${run.profile.toUpperCase()} / ${run.id.slice(0, 8)}`;

    const title = document.createElement("h2");
    title.textContent = run.project;

    const summary = document.createElement("p");
    summary.className = "muted";
    summary.textContent =
      `${run.status} · ${run.elapsed.toFixed(1)}s · ` +
      (run.score === null ? "No score" : `${run.score}/100 simulated`);

    const actions = document.createElement("div");
    actions.className = "button-group";

    const view = document.createElement("button");
    view.className = "secondary";
    view.textContent = "View details";
    view.addEventListener("click", () => inspect(run));

    const download = document.createElement("button");
    download.className = "secondary";
    download.textContent = "JSON ↓";
    download.addEventListener("click", () => downloadReport(run));

    actions.append(view, download);
    card.append(label, title, summary, actions);
    reports.append(card);
  }

  if (!finished.length) {
    const empty = document.createElement("div");
    empty.className = "card empty-panel";
    empty.textContent = "Reports will appear when an evaluation finishes.";
    reports.append(empty);
  }
}

// Browser-local visual preferences.
let preferences = { compact: false, grid: true };

try {
  const saved = JSON.parse(localStorage.getItem("cma-workspace-ui") ?? "null");
  if (saved) {
    preferences = {
      compact: saved.compact === true,
      grid: saved.grid !== false,
    };
  }
} catch {
  // Defaults remain usable if browser storage is unavailable.
}

function applyPreferences() {
  document.body.classList.toggle("compact-workspace", preferences.compact);
  document.body.classList.toggle("no-workspace-grid", !preferences.grid);

  el<HTMLInputElement>("compact-layout").checked = preferences.compact;
  el<HTMLInputElement>("show-grid").checked = preferences.grid;
}

function savePreferences() {
  preferences.compact = el<HTMLInputElement>("compact-layout").checked;
  preferences.grid = el<HTMLInputElement>("show-grid").checked;
  applyPreferences();

  try {
    localStorage.setItem("cma-workspace-ui", JSON.stringify(preferences));
    el("preference-status").textContent = "Preferences saved on this device.";
  } catch {
    el("preference-status").textContent =
      "Applied for this session; browser storage is unavailable.";
  }
}

el("compact-layout").addEventListener("change", savePreferences);
el("show-grid").addEventListener("change", savePreferences);

window.addEventListener("cma:state", (event) => {
  state = (event as CustomEvent<WorkspaceState>).detail;
  renderWorkspace();
});

applyPreferences();
renderWorkspace();
window.dispatchEvent(new Event("cma:request-state"));