let project = null;
let settingsModal = null;

$(async function () {
  settingsModal = new bootstrap.Modal("#settingsModal");

  // Load or create project
  project = loadProject() || newProject();
  saveProject(project);

  // Populate models
  populateModelSelect("#modelSelect");

  // Bindings
  $("#btnSaveMeta").on("click", onSaveMeta);
  $("#btnRename").on("click", onRename);
  $("#btnNew").on("click", onNew);
  $("#btnExport").on("click", () => exportZip(project));
  $("#btnSettings").on("click", () => {
    $("#openrouterKey").val(localStorage.getItem(LS_KEYS.OPENROUTER) || "");
    settingsModal.show();
  });
  $("#saveKey").on("click", () => {
    const v = $("#openrouterKey").val().trim();
    if (!v) {
      localStorage.removeItem(LS_KEYS.OPENROUTER);
      alert("Key cleared.");
    } else {
      localStorage.setItem(LS_KEYS.OPENROUTER, v);
      alert("Key saved locally.");
    }
    settingsModal.hide();
  });
  $("#btnGenerate").on("click", onGenerate);

  // Render UI
  renderMeta();
  renderRevisions();
  if (project.revisions[0]) loadRevision(project.revisions[0].id);
});

function onSaveMeta() {
  project.title = $("#metaTitle").val();
  project.desc = $("#metaDesc").val();
  saveProject(project);
}

function onRename() {
  const t = prompt("Rename project to:", project.title);
  if (!t) return;
  project.title = t;
  saveProject(project);
  renderMeta();
}

function onNew() {
  if (
    !confirm(
      "Start a new project? Unsaved changes remain in localStorage for the current one."
    )
  )
    return;
  project = newProject();
  saveProject(project);
  renderMeta();
  renderRevisions();
  $("#preview").attr("src", "about:blank");
}

async function onGenerate() {
  const prompt = $("#prompt").val().trim();
  const model = $("#modelSelect").val();
  if (!prompt) {
    alert("Type a prompt first.");
    return;
  }
  $("#btnGenerate").prop("disabled", true);
  $("#genStatus").text("generating…");
  try {
    const out = await callOpenRouter(model, prompt);
    const rev = {
      id: `rev_${Date.now()}`,
      ts: Date.now(),
      prompt,
      html: out.html || "",
      css: out.css || "",
      js: out.js || "",
    };
    addRevision(project, rev);
    renderRevisions();
    loadRevision(rev.id);
    $("#prompt").val("");
    $("#genStatus").text("done");
  } catch (e) {
    console.error(e);
    alert(e.message || "Generation failed.");
    $("#genStatus").text("error");
  } finally {
    $("#btnGenerate").prop("disabled", false);
    setTimeout(() => $("#genStatus").text("idle"), 1200);
  }
}
