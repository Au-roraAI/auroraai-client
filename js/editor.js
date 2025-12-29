import { KeyManager } from './key.js';

// --- STATE MANAGEMENT ---
const STORAGE_KEY = 'aurora_workspace_v2';

let workspace = {
    projects: [], 
    activeProjectId: null
};

// --- INITIALIZATION ---
init();

function init() {
    loadWorkspace();
    if (workspace.activeProjectId) {
        openProjectUI(workspace.activeProjectId);
    } else {
        showDashboard();
    }
    bindEvents();
    initCustomSelector();
    updateKeyStatus();
}

function bindEvents() {
    // Global & Nav
    $('#btn-new-project').on('click', createNewProject);
    $('#btn-back-dashboard').on('click', closeProject);
    $('#menu-close-project').on('click', closeProject);
    $('#btn-global-settings').on('click', () => new bootstrap.Modal(document.getElementById('settingsModal')).show());

    // Dashboard
    $('#projects-list').on('click', '.project-card', function(e) {
        const id = $(this).data('id');
        if ($(e.target).closest('.btn-delete-project').length) {
            deleteProject(id);
        } else {
            openProjectUI(id);
        }
    });

    // Editor Core
    $('#btn-generate').on('click', handleGenerate);
    
    // Inputs (Auto-save)
    $('#project-title, #project-desc').on('input', function() {
        const proj = getActiveProject();
        if(proj) {
            proj.title = $('#project-title').val();
            proj.description = $('#project-desc').val();
            saveWorkspace();
        }
    });

    // Revisions
    $('#revisions-container').on('click', '.revision-card', function(e) {
        // IGNORE if the delete button was clicked
        if ($(e.target).hasClass('btn-delete-rev')) return;
        selectRevision($(this).data('id'));
    });

    // NEW: Revisions Deletion
    $('#revisions-container').on('click', '.btn-delete-rev', function(e) {
        e.stopPropagation(); // Stop the card from being selected
        const revId = $(this).closest('.revision-card').data('id');
        deleteRevision(revId);
    });

    // Menubar
    $('#menu-export-html').on('click', exportHTML);
    $('#menu-view-code').on('click', viewCode);
    $('#menu-new-tab').on('click', openInNewTab);
    $('#menu-refresh').on('click', () => {
        const iframe = document.getElementById('preview-frame');
        iframe.srcdoc = iframe.srcdoc;
    });
    $('#menu-debug-info').on('click', showDebugInfo);

    // Settings
    $('#btn-save-key').on('click', handleSaveKey);
    $('#btn-clear-key').on('click', handleClearKey);

    // AI Tools
    $('#btn-enhance-prompt').on('click', enhancePrompt);
    $('#btn-idea-generator').on('click', generateIdeas);
    $('#idea-bubbles-container').on('click', '.idea-bubble', function() {
        const ideaText = $(this).data('prompt');
        const currentVal = $('#prompt-input').val();
        $('#prompt-input').val(currentVal ? currentVal + "\n\n" + ideaText : ideaText);
        $('#idea-bubbles-container').slideUp(200, function() { $(this).empty(); });
        $('#prompt-input').focus();
    });
    
    // Inspection Tabs
    $('.tab-btn').on('click', function() {
        const targetId = $(this).data('target');
        $('.tab-btn').removeClass('active');
        $(this).addClass('active');
        $('.inspection-view').removeClass('active');
        $(`#${targetId}`).addClass('active');
    });

    $('#btn-copy-content').on('click', function() {
        const activeView = $('.inspection-view.active').attr('id');
        const text = activeView === 'view-code' ? $('#code-content').text() : $('#reasoning-content').text();
        navigator.clipboard.writeText(text);
        const originalText = $(this).text();
        $(this).text("Copied!");
        setTimeout(() => $(this).text(originalText), 1500);
    });
}

// --- CORE GENERATION LOGIC (THE BIG CHANGE) ---

async function handleGenerate() {
    const proj = getActiveProject();
    if(!proj) return;

    const prompt = $('#prompt-input').val().trim();
    if (!prompt) return alert("Please enter a prompt");

    // Get Model
    let model = $('#model-select-value').val();
    if (model === 'custom_mode') {
        model = $('#model-custom-input').val().trim();
        if(!model) return alert("Please enter a custom model ID");
    }

    const apiKey = await KeyManager.getEffectiveKey();
    if (!apiKey) {
        if(confirm("No API Key. Use Mock Generator?")) {
            generateMock(prompt, model);
        } else {
            new bootstrap.Modal(document.getElementById('settingsModal')).show();
        }
        return;
    }

    // DETERMINE MODE: CREATE vs EDIT
    // If we have an active revision with code, we are in EDIT mode.
    let currentCode = null;
    let mode = 'CREATE';
    
    if (proj.selectedRevisionId) {
        const activeRev = proj.revisions.find(r => r.id === proj.selectedRevisionId);
        if (activeRev && activeRev.html) {
            currentCode = activeRev.html;
            mode = 'EDIT';
        }
    }

    setLoading(true, mode === 'EDIT' ? "PATCHING..." : "GENERATING...");
    
    try {
        let resultHTML = "";
        let reasoning = "";
        let debugRaw = {};

        if (mode === 'CREATE') {
            // --- CREATE MODE (Full Generation) ---
            const result = await callOpenRouterCreate(apiKey, model, prompt);
            resultHTML = result.html;
            reasoning = result.reasoning;
            debugRaw = result.rawData;
        } else {
            // --- EDIT MODE (Search & Replace) ---
            const result = await callOpenRouterEdit(apiKey, model, prompt, currentCode);
            
            // Apply the patch
            if (result.isFullReplace) {
                resultHTML = result.html; // AI decided to rewrite anyway
            } else {
                resultHTML = applyPatches(currentCode, result.patches);
            }
            
            reasoning = result.reasoning;
            debugRaw = result.rawData;
        }

        addRevision(proj, prompt, model, resultHTML, debugRaw, reasoning);

    } catch (err) {
        console.error(err);
        alert("Generation Failed: " + err.message);
    } finally {
        setLoading(false);
    }
}

// --- API CALLS ---

async function callOpenRouterCreate(key, model, prompt) {
    const systemPrompt = `
        You are an expert Front-End Engineer.
        Generate a single, complete HTML file containing CSS and JS.
        The design should be modern, responsive, and beautiful.
        Output RAW HTML only. No markdown.
    `;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://aurora-editor.local",
            "X-Title": "Aurora Editor"
        },
        body: JSON.stringify({
            "model": model,
            "messages": [
                {"role": "system", "content": systemPrompt},
                {"role": "user", "content": `Create a new web app: ${prompt}`}
            ]
        })
    });

    return processResponse(response);
}

async function callOpenRouterEdit(key, model, prompt, currentCode) {
    const systemPrompt = `
        You are an expert Code Editor. You will receive an existing HTML file and a user request.
        
        DO NOT regenerate the entire file.
        Instead, output a JSON object containing a list of text replacements.
        
        Format:
        {
            "patches": [
                {
                    "original_snippet": "exact string to find",
                    "new_snippet": "replacement string"
                }
            ]
        }
        
        RULES:
        1. "original_snippet" must match the existing code EXACTLY (whitespace included) or the patch will fail.
        2. Pick unique snippets large enough to be unique, but small enough to match reliably.
        3. If the change is massive (over 50% of code), you may return {"full_replace": "..."} with the new full HTML string instead.
        4. Output ONLY valid JSON.
    `;

    // We truncate context if it's too huge to save tokens/errors
    const contextCode = currentCode.length > 50000 ? currentCode.substring(0, 50000) + "\n" : currentCode;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://aurora-editor.local",
            "X-Title": "Aurora Editor"
        },
        body: JSON.stringify({
            "model": model,
            "response_format": { type: "json_object" }, // Force JSON if supported
            "messages": [
                {"role": "system", "content": systemPrompt},
                {"role": "user", "content": `CURRENT CODE:\n${contextCode}\n\nUSER REQUEST: ${prompt}`}
            ]
        })
    });

    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || "Unknown API Error");
    }

    const data = await response.json();
    let content = data.choices[0].message.content;
    let reasoning = data.choices[0].message.reasoning || null;

    // Handle Think Tags
    if (!reasoning) {
        const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i);
        if (thinkMatch) {
            reasoning = thinkMatch[1].trim();
            content = content.replace(/<think>[\s\S]*?<\/think>/i, '');
        }
    }

    // Clean JSON
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();
    
    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch (e) {
        // Fallback: If AI failed JSON, treat as full HTML
        console.warn("AI returned invalid JSON, treating as full replace.");
        return { isFullReplace: true, html: content, rawData: data, reasoning };
    }

    if (parsed.full_replace) {
        return { isFullReplace: true, html: parsed.full_replace, rawData: data, reasoning };
    }

    return { isFullReplace: false, patches: parsed.patches || [], rawData: data, reasoning };
}

async function processResponse(response) {
    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || "Unknown API Error");
    }
    const data = await response.json();
    let content = data.choices[0].message.content;
    let reasoning = data.choices[0].message.reasoning || null;

    if (!reasoning) {
        const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i);
        if (thinkMatch) {
            reasoning = thinkMatch[1].trim();
            content = content.replace(/<think>[\s\S]*?<\/think>/i, '');
        }
    }
    content = content.replace(/```html/g, '').replace(/```/g, '').trim();
    return { html: content, rawData: data, reasoning: reasoning };
}

// --- PATCH ENGINE ---

function applyPatches(source, patches) {
    let result = source;
    let successCount = 0;

    patches.forEach(patch => {
        // We use replace() which replaces the FIRST occurrence.
        // This is why context is important.
        if (result.includes(patch.original_snippet)) {
            result = result.replace(patch.original_snippet, patch.new_snippet);
            successCount++;
        } else {
            console.warn("Patch failed: Snippet not found", patch.original_snippet);
            // Fallback: Try a whitespace-insensitive match (Basic normalization)
            // This is complex to implement perfectly in JS without diff-match-patch libs,
            // so we stick to strict matching for this demo to ensure safety.
        }
    });

    console.log(`Applied ${successCount}/${patches.length} patches.`);
    
    // Safety check: If result is empty or broken, return source (drift protection)
    if (result.length < 10) return source;
    
    return result;
}

// --- REST OF APP (Same as before) ---
// (Workspace, UI Rendering, Custom Selector, etc...)

function createNewProject() {
    const newProj = {
        id: Date.now(),
        title: "Untitled Project",
        description: "",
        revisions: [],
        selectedRevisionId: null,
        created: new Date().toLocaleDateString()
    };
    workspace.projects.unshift(newProj);
    saveWorkspace();
    openProjectUI(newProj.id);
}

function deleteProject(id) {
    if(!confirm("Delete project?")) return;
    workspace.projects = workspace.projects.filter(p => p.id !== id);
    if(workspace.activeProjectId === id) workspace.activeProjectId = null;
    saveWorkspace();
    showDashboard();
}

function getActiveProject() {
    return workspace.projects.find(p => p.id === workspace.activeProjectId);
}

function showDashboard() {
    workspace.activeProjectId = null;
    saveWorkspace();
    $('#view-editor').addClass('d-none').removeClass('d-flex');
    $('#view-dashboard').removeClass('d-none').addClass('d-flex');
    
    const container = $('#projects-list');
    container.empty();

    if(workspace.projects.length === 0) {
        container.html('<div class="text-center text-muted mt-5">No projects found. Create one!</div>');
    } else {
        workspace.projects.forEach(p => {
            const card = `
                <div class="project-card mb-3 p-3 border border-secondary rounded bg-dark position-relative" style="cursor:pointer; border-color: rgba(255,255,255,0.1) !important;" data-id="${p.id}">
                    <div class="d-flex justify-content-between align-items-start">
                        <div>
                            <h6 class="text-white mb-1 fw-bold">${p.title || 'Untitled'}</h6>
                            <div class="text-muted small">${p.revisions.length} revisions • ${p.created}</div>
                        </div>
                        <button class="btn btn-sm btn-outline-danger btn-delete-project" style="z-index:2; font-size:0.7rem; padding: 2px 6px;">✕</button>
                    </div>
                </div>
            `;
            container.append(card);
        });
    }
    $('#preview-frame').attr('srcdoc', '<body style="background:#000; display:flex; justify-content:center; align-items:center; height:100vh; color:#444; font-family:sans-serif;">Select a project</body>');
}

function openProjectUI(id) {
    const proj = workspace.projects.find(p => p.id === id);
    if(!proj) return showDashboard();

    workspace.activeProjectId = id;
    saveWorkspace();

    $('#view-dashboard').addClass('d-none').removeClass('d-flex');
    $('#view-editor').removeClass('d-none').addClass('d-flex');

    $('#project-title').val(proj.title);
    $('#project-desc').val(proj.description);

    renderRevisions();
    
    if(proj.selectedRevisionId) {
        selectRevision(proj.selectedRevisionId, false);
    } else {
        $('#preview-frame').attr('srcdoc', '<body style="background:white; display:flex; justify-content:center; align-items:center; height:100vh; color:#ccc;">Ready to generate...</body>');
    }
}

function closeProject() { showDashboard(); }

function addRevision(proj, prompt, model, html, debugInfo, reasoning) {
    const newRev = {
        id: Date.now(),
        timestamp: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
        prompt: prompt,
        model: model,
        html: html,
        debugInfo: debugInfo,
        reasoning: reasoning
    };
    proj.revisions.unshift(newRev);
    proj.selectedRevisionId = newRev.id;
    saveWorkspace();
    renderRevisions();
    loadFrame(html);
}

function selectRevision(revId, renderList = true) {
    const proj = getActiveProject();
    if(!proj) return;
    
    proj.selectedRevisionId = revId;
    saveWorkspace();

    const rev = proj.revisions.find(r => r.id === revId);
    if(rev) {
        loadFrame(rev.html);
        if(renderList) renderRevisions();
    }
}

function renderRevisions() {
    const proj = getActiveProject();
    if(!proj) return;

    const container = $('#revisions-container');
    container.empty();
    $('#rev-count').text(proj.revisions.length);

    if (proj.revisions.length === 0) {
        container.append(`<div class="text-center text-muted mt-5 small">No revisions yet.</div>`);
    } else {
        proj.revisions.forEach(rev => {
            const isActive = rev.id === proj.selectedRevisionId;
            const item = `
                <div class="revision-card ${isActive ? 'active' : ''}" data-id="${rev.id}">
                    <div class="rev-header">
                        <span class="font-mono text-accent">${rev.model.split('/')[1] || 'model'}</span>
                        <span>${rev.timestamp}</span>
                    </div>
                    <div class="rev-prompt">${rev.prompt}</div>
                    
                    <button class="btn-delete-rev" title="Delete Revision">✕</button>
                </div>
            `;
            container.append(item);
        });
    }
}

function loadFrame(html) {
    $('#preview-frame').attr('srcdoc', html);
    $('#status-indicator').addClass('active');
}

// Helpers
function generateMock(prompt, model) {
    const proj = getActiveProject();
    if(!proj) return;
    setLoading(true, "MOCKING...");
    setTimeout(() => {
        const mockHtml = `<html><body style="background:#f4f4f5; display:flex; justify-content:center; align-items:center; height:100vh;"><h1>Mock Result</h1><p>${prompt}</p></body></html>`;
        addRevision(proj, prompt, model, mockHtml, { mock: true }, "I thought about it, and decided to just mock you.");
        setLoading(false);
    }, 800);
}

function exportHTML(e) {
    e.preventDefault();
    const proj = getActiveProject();
    if(!proj) return alert("Open a project first.");
    const rev = proj.revisions.find(r => r.id === proj.selectedRevisionId) || proj.revisions[0];
    if(!rev) return alert("Nothing to export.");
    let safeTitle = proj.title.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase() || "aurora_export";
    const filename = `${safeTitle}_${rev.id}.html`;
    const blob = new Blob([rev.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
}

function viewCode(e) {
    e.preventDefault();
    const proj = getActiveProject();
    if(!proj) return;
    const rev = proj.revisions.find(r => r.id === proj.selectedRevisionId);
    if(!rev) return alert("No revision selected.");
    
    $('#code-content').text(rev.html);
    
    const reasonBtn = $('#tab-btn-reasoning');
    if (rev.reasoning) {
        reasonBtn.show();
        $('#reasoning-content').text(rev.reasoning);
        $('#menu-view-code').text("View Code & Reasoning");
    } else {
        reasonBtn.hide();
        $('#menu-view-code').text("View Source Code");
    }

    $('.tab-btn[data-target="view-code"]').trigger('click');
    new bootstrap.Modal(document.getElementById('codeModal')).show();
}

function openInNewTab(e) {
    e.preventDefault();
    const proj = getActiveProject();
    if(!proj) return;
    const rev = proj.revisions.find(r => r.id === proj.selectedRevisionId);
    if(!rev) return;
    const blob = new Blob([rev.html], { type: 'text/html' });
    window.open(URL.createObjectURL(blob), '_blank');
}

function showDebugInfo(e) {
    e.preventDefault();
    const proj = getActiveProject();
    if(!proj) return;
    const rev = proj.revisions.find(r => r.id === proj.selectedRevisionId);
    if(!rev) return;
    $('#debug-content').text(JSON.stringify(rev.debugInfo || {}, null, 2));
    new bootstrap.Modal(document.getElementById('debugModal')).show();
}

function setLoading(isLoading, text="GENERATING...") {
    if (isLoading) {
        $('#loading-overlay').addClass('visible').find('.text-muted').text(text);
        $('#btn-generate').prop('disabled', true).text('Working...');
    } else {
        $('#loading-overlay').removeClass('visible');
        $('#btn-generate').prop('disabled', false).text('Generate');
    }
}

function loadWorkspace() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            workspace = JSON.parse(saved);
        }
    } catch (e) { console.warn("Workspace corrupted", e); }
}

function saveWorkspace() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
}

// Custom Selector Logic
function initCustomSelector() {
    const wrapper = document.querySelector('.custom-select-wrapper');
    const select = wrapper.querySelector('.custom-select');
    const trigger = wrapper.querySelector('.custom-select__trigger');
    const label = document.getElementById('current-model-label');
    const hiddenInput = document.getElementById('model-select-value');
    const options = wrapper.querySelectorAll('.custom-option');
    const customInput = document.getElementById('model-custom-input');
    const tooltipEl = document.getElementById('aurora-tooltip');

    document.querySelectorAll('.info-icon').forEach(icon => {
        icon.addEventListener('mouseenter', (e) => {
            const text = icon.getAttribute('data-tooltip');
            if (!text) return;
            tooltipEl.textContent = text;
            tooltipEl.classList.add('visible');
            const rect = icon.getBoundingClientRect();
            const top = rect.top + (rect.height / 2) - (tooltipEl.offsetHeight / 2);
            const left = rect.left - tooltipEl.offsetWidth - 10; 
            tooltipEl.style.top = `${top}px`;
            tooltipEl.style.left = `${left}px`;
        });
        icon.addEventListener('mouseleave', () => {
            tooltipEl.classList.remove('visible');
        });
    });

    trigger.addEventListener('click', (e) => {
        select.classList.toggle('open');
        e.stopPropagation();
    });

    document.addEventListener('click', (e) => {
        if (!select.contains(e.target)) {
            select.classList.remove('open');
        }
    });

    options.forEach(option => {
        option.addEventListener('click', function(e) {
            options.forEach(o => o.classList.remove('selected'));
            this.classList.add('selected');
            const val = this.getAttribute('data-value');
            const nameSpan = this.querySelector('.model-name');
            const text = nameSpan ? nameSpan.textContent : this.textContent;
            label.textContent = text;
            hiddenInput.value = val;
            select.classList.remove('open');
            if (val === 'custom_mode') {
                customInput.classList.remove('d-none');
                customInput.focus();
            } else {
                customInput.classList.add('d-none');
            }
        });
    });
}

// Enhance & Idea Logic
async function enhancePrompt() {
    const current = $('#prompt-input').val().trim();
    if (!current) return alert("Please type a basic prompt first.");
    const btn = $('#btn-enhance-prompt');
    const originalText = btn.html();
    btn.prop('disabled', true).html('✨ Thinking...');
    try {
        const apiKey = await KeyManager.getEffectiveKey();
        if (!apiKey) throw new Error("API Key required.");
        const systemPrompt = "You are a prompt engineer. Rewrite the user's web design prompt to be detailed. Output ONLY the new prompt.";
        const enhanced = await callAIHelper(apiKey, systemPrompt, current);
        $('#prompt-input').val(enhanced);
    } catch (e) {
        console.error(e);
        alert("Enhance failed: " + e.message);
    } finally {
        btn.prop('disabled', false).html(originalText);
    }
}

async function generateIdeas() {
    const proj = getActiveProject();
    const currentPrompt = $('#prompt-input').val().trim();
    const projectTitle = proj ? proj.title : "Untitled";
    const projectDesc = proj ? proj.description : "";
    
    let currentCode = "";
    if (proj && proj.selectedRevisionId) {
        const rev = proj.revisions.find(r => r.id === proj.selectedRevisionId);
        if (rev) currentCode = rev.html;
    }

    const btn = $('#btn-idea-generator');
    const originalText = btn.html();
    btn.prop('disabled', true).html('🧠 Analyzing...');
    
    const container = $('#idea-bubbles-container');
    container.show().html('<div class="text-muted small w-100 ps-2">Reading code & brainstorming...</div>');

    try {
        const apiKey = await KeyManager.getEffectiveKey();
        if (!apiKey) throw new Error("API Key required.");

        const systemPrompt = `
            You are a creative Product Manager. Analyze the user's project and code.
            Suggest 3 distinct, actionable features.
            Output ONLY valid JSON: [{"label": "...", "prompt": "..."}, ...]
        `;
        const userContext = `Title: ${projectTitle}\nDesc: ${projectDesc}\nPrompt: ${currentPrompt}\nCode: ${currentCode.substring(0, 15000)}`;

        const responseText = await callAIHelper(apiKey, systemPrompt, userContext);
        let jsonStr = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const ideas = JSON.parse(jsonStr);

        container.empty();
        ideas.forEach(idea => {
            const bubble = $(`<div class="idea-bubble" title="${idea.prompt}">+ ${idea.label}</div>`);
            bubble.data('prompt', idea.prompt);
            container.append(bubble);
        });

    } catch (e) {
        console.error(e);
        container.html(`<div class="text-danger small w-100 ps-2">Error: ${e.message}</div>`);
    } finally {
        btn.prop('disabled', false).html(originalText);
    }
}

async function callAIHelper(key, sysPrompt, userPrompt) {
    const TOOL_MODEL = "google/gemini-2.0-flash-exp:free"; 
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://aurora-editor.local",
            "X-Title": "Aurora Editor Tools"
        },
        body: JSON.stringify({
            "model": TOOL_MODEL,
            "messages": [
                {"role": "system", "content": sysPrompt},
                {"role": "user", "content": userPrompt}
            ],
            "temperature": 0.7
        })
    });
    if (!response.ok) throw new Error("AI Helper Error");
    const data = await response.json();
    return data.choices[0].message.content;
}

// Pass-through Keys
function handleSaveKey() {
    const key = $('#user-api-key').val().trim();
    if (key) {
        KeyManager.setUserKey(key);
        $('#user-api-key').val(''); 
        bootstrap.Modal.getInstance(document.getElementById('settingsModal')).hide();
        updateKeyStatus();
    }
}
function handleClearKey() {
    KeyManager.clearUserKey();
    updateKeyStatus();
    bootstrap.Modal.getInstance(document.getElementById('settingsModal')).hide();
}
async function updateKeyStatus() {
    const userKey = KeyManager.getUserKey();
    const devKey = await KeyManager.fetchDevKey();
    const statusDiv = $('#key-status');
    if (userKey) statusDiv.html('<span class="text-success">● User Key Active</span>');
    else if (devKey) statusDiv.html('<span class="text-warning">● Dev Key Active (Local)</span>');
    else statusDiv.html('<span class="text-danger">● No API Key</span>');
}

function deleteRevision(revId) {
    if(!confirm("Are you sure you want to delete this revision? This cannot be undone.")) return;

    const proj = getActiveProject();
    if (!proj) return;

    // 1. Remove the revision
    const originalLength = proj.revisions.length;
    proj.revisions = proj.revisions.filter(r => r.id !== revId);

    // 2. Handle Active State Logic
    if (proj.selectedRevisionId === revId) {
        if (proj.revisions.length > 0) {
            // If we deleted the active one, switch to the newest one (index 0)
            // or effectively "undo" to the previous state
            selectRevision(proj.revisions[0].id);
        } else {
            // Project is now empty
            proj.selectedRevisionId = null;
            $('#preview-frame').attr('srcdoc', '<body style="background:white; display:flex; justify-content:center; align-items:center; height:100vh; color:#ccc;">Ready to generate...</body>');
        }
    }

    saveWorkspace();
    renderRevisions();
}