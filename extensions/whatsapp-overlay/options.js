import {
  addServer,
  getAuthState,
  maskKey,
  removeServer,
  setActive,
  subscribe,
  testConnection,
  updateServer,
} from "./auth.js";

const $ = (id) => document.getElementById(id);

const elements = {
  servers: $("servers"),
  empty: $("empty"),
  form: $("server-form"),
  formTitle: $("form-title"),
  name: $("name"),
  baseUrl: $("baseUrl"),
  contextKey: $("contextKey"),
  saveBtn: $("save-btn"),
  cancelBtn: $("cancel-btn"),
  toast: $("toast"),
};

let editingId = null;
let toastTimer = null;

function showToast(message, kind = "ok") {
  const el = elements.toast;
  el.textContent = message;
  el.classList.remove("ok", "err");
  el.classList.add(kind === "err" ? "err" : "ok", "visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 3200);
}

function resetForm() {
  editingId = null;
  elements.form.reset();
  elements.formTitle.textContent = "Add server";
  elements.saveBtn.textContent = "Save";
  elements.cancelBtn.hidden = true;
}

function startEdit(entry) {
  editingId = entry.id;
  elements.name.value = entry.name;
  elements.baseUrl.value = entry.baseUrl;
  elements.contextKey.value = "";
  elements.contextKey.placeholder = "leave blank to keep current key";
  elements.formTitle.textContent = `Edit ${entry.name}`;
  elements.saveBtn.textContent = "Save changes";
  elements.cancelBtn.hidden = false;
  elements.name.focus();
}

function renderEntry(entry, activeId) {
  const li = document.createElement("li");
  if (entry.id === activeId) li.classList.add("active");

  const head = document.createElement("div");
  head.className = "server-head";

  const left = document.createElement("div");
  const name = document.createElement("div");
  name.className = "server-name";
  name.textContent = entry.name + (entry.id === activeId ? " · active" : "");
  left.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "server-meta";
  const urlCode = document.createElement("code");
  urlCode.textContent = entry.baseUrl;
  meta.appendChild(urlCode);
  meta.appendChild(document.createTextNode(" · "));
  const keySpan = document.createElement("span");
  keySpan.className = "reveal-key";
  keySpan.textContent = maskKey(entry.contextKey);
  const revealBtn = document.createElement("button");
  revealBtn.className = "reveal-toggle";
  revealBtn.type = "button";
  revealBtn.textContent = "reveal";
  let revealed = false;
  revealBtn.addEventListener("click", () => {
    revealed = !revealed;
    keySpan.textContent = revealed ? entry.contextKey : maskKey(entry.contextKey);
    revealBtn.textContent = revealed ? "hide" : "reveal";
  });
  meta.appendChild(keySpan);
  meta.appendChild(revealBtn);
  left.appendChild(meta);
  head.appendChild(left);

  const actions = document.createElement("div");
  actions.className = "server-actions";

  if (entry.id !== activeId) {
    const activeBtn = document.createElement("button");
    activeBtn.textContent = "Set active";
    activeBtn.className = "primary";
    activeBtn.addEventListener("click", async () => {
      try {
        await setActive(entry.id);
        showToast(`Active server: ${entry.name}`);
      } catch (error) {
        showToast(`Failed: ${error.message}`, "err");
      }
    });
    actions.appendChild(activeBtn);
  }

  const testBtn = document.createElement("button");
  testBtn.textContent = "Test";
  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    testBtn.textContent = "Testing…";
    const result = await testConnection(entry);
    testBtn.disabled = false;
    testBtn.textContent = "Test";
    if (result.ok) {
      showToast(`OK · ${result.contextId ?? "auth ok"}`);
    } else {
      showToast(`Failed (${result.status || "net"}): ${result.error}`, "err");
    }
  });
  actions.appendChild(testBtn);

  const editBtn = document.createElement("button");
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => startEdit(entry));
  actions.appendChild(editBtn);

  const delBtn = document.createElement("button");
  delBtn.textContent = "Delete";
  delBtn.className = "danger";
  delBtn.addEventListener("click", async () => {
    if (!confirm(`Remove server "${entry.name}"? This does not revoke the key on the daemon.`)) return;
    try {
      await removeServer(entry.id);
      showToast(`Removed ${entry.name}`);
    } catch (error) {
      showToast(`Failed: ${error.message}`, "err");
    }
  });
  actions.appendChild(delBtn);

  head.appendChild(actions);
  li.appendChild(head);
  return li;
}

async function render() {
  const state = await getAuthState();
  elements.servers.innerHTML = "";
  if (state.servers.length === 0) {
    elements.empty.hidden = false;
    return;
  }
  elements.empty.hidden = true;
  for (const entry of state.servers) {
    elements.servers.appendChild(renderEntry(entry, state.activeId));
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = elements.name.value.trim();
  const baseUrl = elements.baseUrl.value.trim();
  const contextKey = elements.contextKey.value.trim();
  try {
    if (editingId) {
      const partial = { name, baseUrl };
      if (contextKey) partial.contextKey = contextKey;
      await updateServer(editingId, partial);
      showToast(`Updated ${name}`);
    } else {
      if (!contextKey) {
        showToast("Context key required", "err");
        return;
      }
      await addServer({ name, baseUrl, contextKey });
      showToast(`Added ${name}`);
    }
    resetForm();
  } catch (error) {
    showToast(`Failed: ${error.message}`, "err");
  }
});

elements.cancelBtn.addEventListener("click", resetForm);

subscribe(() => {
  render().catch((error) => showToast(`Render failed: ${error.message}`, "err"));
});

render().catch((error) => showToast(`Render failed: ${error.message}`, "err"));
