import { KeyManager } from './key.js';

// =======================================================
//  STATE & CONFIGURATION
// =======================================================
const STORAGE_KEY = 'aurora_workspace_v2';
let workspace = { projects: [], activeProjectId: null };
let lastRuntimeError = null;
let activeBlobs = [];

// =======================================================
//  GLOBAL HELPERS
// =======================================================
window.toggleModule = function(id) { 
    const el = document.getElementById(id);
    if (el) el.classList.toggle('open');
};

// =======================================================
//  SDK INJECTION
// =======================================================
const AURORA_SDK_SCRIPT = `
<script>
(function() {
    if (window.aurora) return;
    window.aurora = {
        _callbacks: {},
        askAI: function(prompt, systemPrompt) {
            return new Promise((resolve, reject) => {
                const id = Math.random().toString(36).substring(7);
                const timeout = setTimeout(() => { delete window.aurora._callbacks[id]; reject(new Error("AI Request Timed Out")); }, 30000);
                window.aurora._callbacks[id] = (response) => {
                    clearTimeout(timeout); delete window.aurora._callbacks[id];
                    if(response.error) reject(new Error(response.error)); else resolve(response.text);
                };
                window.parent.postMessage({ type: 'AURORA_AI_REQUEST', id: id, prompt: prompt, system: systemPrompt }, '*');
            });
        }
    };
    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'AURORA_AI_RESPONSE') {
            const cb = window.aurora._callbacks[event.data.id]; if (cb) cb(event.data);
        }
    });
    window.addEventListener('error', function(event) {
        window.parent.postMessage({ type: 'AURORA_RUNTIME_ERROR', error: { message: event.message || "Unknown Error", line: event.lineno, column: event.colno, stack: event.error ? event.error.stack : 'SyntaxError or Parse Error' } }, '*');
        return false;
    }, true);
    window.addEventListener('unhandledrejection', function(event) {
        window.parent.postMessage({ type: 'AURORA_RUNTIME_ERROR', error: { message: 'Unhandled Promise Rejection: ' + event.reason, stack: event.reason ? event.reason.stack : '' } }, '*');
    });
})();
</script>
`;

// =======================================================
//  INITIALIZATION
// =======================================================
init();

function init() {
    loadWorkspace();
    
    // Bind listeners
    bindEvents();
    initCustomSelector();
    initBridgeListener(); // <--- This function is now restored below
    
    // UI State
    if (workspace.activeProjectId) openProjectUI(workspace.activeProjectId);
    else showDashboard();
    
    updateKeyStatus();
    $('#preview-frame').on('load', function() { initIframeSpy(this); });
}

// --- RESTORED BRIDGE LISTENER ---
function initBridgeListener() {
    window.addEventListener('message', async (event) => {
        if (!event.data) return;
        
        // 1. Handle AI Requests from the App
        if (event.data.type === 'AURORA_AI_REQUEST') {
            const { id, prompt, system } = event.data;
            const iframe = document.getElementById('preview-frame');
            if (!iframe || !iframe.contentWindow) return;
            
            try {
                const apiKey = await KeyManager.getEffectiveKey();
                if(!apiKey) throw new Error("Editor API Key missing");
                
                // Use fast helper model for in-app AI
                const responseText = await callAIHelper(apiKey, system || "You are a helpful assistant.", prompt);
                
                iframe.contentWindow.postMessage({ 
                    type: 'AURORA_AI_RESPONSE', 
                    id: id, 
                    text: responseText 
                }, '*');
            } catch (e) {
                iframe.contentWindow.postMessage({ 
                    type: 'AURORA_AI_RESPONSE', 
                    id: id, 
                    error: e.message || "Bridge Error" 
                }, '*');
            }
        }
        
        // 2. Handle Runtime Errors from the App
        if (event.data.type === 'AURORA_RUNTIME_ERROR') {
            lastRuntimeError = event.data.error;
            $('#error-message-display').text(`${lastRuntimeError.message}\n\nLine: ${lastRuntimeError.line}\n${lastRuntimeError.stack}`);
            new bootstrap.Modal(document.getElementById('errorModal')).show();
        }
    });
}

function initIframeSpy(iframe) {
    try {
        if (iframe.contentWindow) {
            iframe.contentWindow.addEventListener('error', function(event) {
                window.postMessage({ 
                    type: 'AURORA_RUNTIME_ERROR', 
                    error: { 
                        message: event.message, 
                        line: event.lineno, 
                        column: event.colno, 
                        stack: event.error ? event.error.stack : 'Parent-Caught Error' 
                    } 
                }, '*');
            }, true);
        }
    } catch (e) { console.warn("Spy failed:", e); }
}

// =======================================================
//  EVENT BINDING
// =======================================================
function bindEvents() {
    // Nav
    $('#btn-new-project').on('click', createNewProject);
    $('#btn-back-dashboard').on('click', closeProject);
    $('#menu-close-project').on('click', closeProject);
    $('#btn-global-settings').on('click', () => new bootstrap.Modal(document.getElementById('settingsModal')).show());
    
    // Dashboard
    $('#projects-list').on('click', '.project-card', function(e) {
        const id = $(this).data('id');
        if ($(e.target).closest('.btn-delete-project').length) deleteProject(id);
        else openProjectUI(id);
    });

    // Core
    $('#btn-generate').on('click', handleGenerate);
    $('input[name="mode-switch"]').on('change', function() {
        if ($('#mode-agent').is(':checked')) enableAgentMode();
        else enableGeneratorMode();
    });

    // Agent
    $('#btn-new-chat').on('click', startNewChat);
    $('#btn-send-agent').on('click', handleUserSubmit);
    $('#agent-input').on('keydown', function(e) { 
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleUserSubmit(); }
    });
    
    const agentChat = $('#agent-chat-history');
    agentChat.on('click', '.citation', function(e) { e.preventDefault(); openCodeAtLine($(this).data('file'), $(this).data('line')); });
    agentChat.on('click', '.btn-edit-msg', function() { enterEditMode($(this).closest('.chat-message').data('index')); });
    agentChat.on('click', '.btn-save-edit', function() { saveEdit($(this).closest('.chat-message').data('index'), $(this).closest('.chat-bubble').find('textarea').val()); });
    agentChat.on('click', '.btn-cancel-edit', function() { renderAgentChat(); });

    // File Explorer
    $('#file-list').on('click', '.file-item', function() {
        viewCodeForFile($(this).data('file'));
    });

    // Revisions
    $('#revisions-container').on('click', '.revision-card', function(e) {
        if ($(e.target).hasClass('btn-delete-rev') || $(e.target).hasClass('status-clickable')) return;
        selectRevision($(this).data('id'));
    });
    $('#revisions-container').on('click', '.btn-delete-rev', function(e) { e.stopPropagation(); deleteRevision($(this).closest('.revision-card').data('id')); });
    $('#revisions-container').on('click', '.status-clickable', function(e) { e.stopPropagation(); showPatchDetails($(this).closest('.revision-card').data('id')); });

    // Inputs
    $('#project-title, #project-desc').on('input', function() {
        const proj = getActiveProject();
        if(proj) { proj.title = $('#project-title').val(); proj.description = $('#project-desc').val(); saveWorkspace(); }
    });

    // Tools
    $('#menu-export-html').on('click', exportSingleHTML);
    $('#menu-view-code').on('click', viewCode);
    $('#menu-new-tab').on('click', openInNewTab);
    $('#menu-refresh').on('click', () => { const f = document.getElementById('preview-frame'); f.srcdoc = f.srcdoc; });
    $('#menu-debug-info').on('click', showDebugInfo);
    
    $('#btn-save-key').on('click', handleSaveKey);
    $('#btn-clear-key').on('click', handleClearKey);
    $('#btn-enhance-prompt').on('click', enhancePrompt);
    $('#btn-idea-generator').on('click', generateIdeas);
    $('#btn-auto-fix').on('click', handleAutoFix);
    $('#idea-bubbles-container').on('click', '.idea-bubble', function() {
        const t = $(this).data('prompt'); const v = $('#prompt-input').val();
        $('#prompt-input').val(v ? v + "\n\n" + t : t);
        $('#idea-bubbles-container').slideUp(200, function() { $(this).empty(); }); $('#prompt-input').focus();
    });

    // Modals
    $('.tab-btn').on('click', function() {
        const t = $(this).data('target'); $('.tab-btn').removeClass('active'); $(this).addClass('active');
        $('.inspection-view').removeClass('active'); $(`#${t}`).addClass('active');
    });
    $('#btn-copy-content').on('click', function() {
        const v = $('.inspection-view.active').attr('id'); const t = v === 'view-code' ? $('#code-content').text() : $('#reasoning-content').text();
        navigator.clipboard.writeText(t); const o = $(this).text(); $(this).text("Copied!"); setTimeout(() => $(this).text(o), 1500);
    });
    $('#code-file-select').on('change', function() { viewCodeForFile($(this).val()); });
}

// =======================================================
//  UI MODES
// =======================================================
function enableAgentMode() {
    $('#mod-info').hide();
    $('#mod-timeline').removeClass('d-flex').hide();
    $('#mod-composer').hide();
    $('#mod-files').hide();
    
    const agentMod = $('#mod-agent');
    agentMod.removeClass('d-none').addClass('d-flex open');
    
    renderAgentChat();
    const chatContainer = $('#agent-chat-history');
    if(chatContainer[0]) chatContainer.scrollTop(chatContainer[0].scrollHeight);
}

function enableGeneratorMode() {
    $('#mod-info').show();
    $('#mod-timeline').addClass('d-flex').show();
    $('#mod-composer').show();
    $('#mod-files').show();
    
    $('#mod-agent').removeClass('d-flex open').addClass('d-none');
}

// =======================================================
//  VIRTUAL FILE SYSTEM
// =======================================================
function compileProject(files) {
    activeBlobs.forEach(url => URL.revokeObjectURL(url));
    activeBlobs = [];

    const fileNames = Object.keys(files).sort((a, b) => b.length - a.length);
    const assetFiles = fileNames.filter(f => !f.endsWith('.html'));
    const htmlFiles = fileNames.filter(f => f.endsWith('.html'));
    const finalBlobs = {};

    assetFiles.forEach(name => {
        const content = files[name];
        const type = getMimeType(name);
        const blob = new Blob([content], { type: type });
        const url = URL.createObjectURL(blob);
        finalBlobs[name] = url;
        activeBlobs.push(url);
    });

    htmlFiles.forEach(name => {
        let content = files[name];
        if (content.includes('<head>')) content = content.replace('<head>', '<head>\n' + AURORA_SDK_SCRIPT);
        else content = AURORA_SDK_SCRIPT + content;

        Object.keys(finalBlobs).forEach(assetName => {
            content = content.split(assetName).join(finalBlobs[assetName]);
        });

        const type = 'text/html';
        const blob = new Blob([content], { type: type });
        const url = URL.createObjectURL(blob);
        finalBlobs[name] = url;
        activeBlobs.push(url);
    });

    return finalBlobs['index.html'] || Object.values(finalBlobs)[0];
}

function getMimeType(filename) {
    if (filename.endsWith('.css')) return 'text/css';
    if (filename.endsWith('.js')) return 'application/javascript';
    if (filename.endsWith('.json')) return 'application/json';
    if (filename.endsWith('.svg')) return 'image/svg+xml';
    return 'text/plain';
}

// =======================================================
//  GENERATION CORE
// =======================================================
async function handleGenerate() {
    const proj = getActiveProject(); if(!proj) return;
    const prompt = $('#prompt-input').val().trim(); if (!prompt) return alert("Enter prompt");
    let model = $('#model-select-value').val(); if (model === 'custom_mode') model = $('#model-custom-input').val().trim();
    const apiKey = await KeyManager.getEffectiveKey(); if (!apiKey) return alert("Key required");

    let currentFiles = {};
    let mode = 'CREATE';
    
    if (proj.selectedRevisionId) {
        const r = proj.revisions.find(x => x.id === proj.selectedRevisionId);
        if (r) {
            if (r.files) { currentFiles = r.files; mode = 'EDIT'; }
            else if (r.html) { currentFiles = { 'index.html': r.html }; mode = 'EDIT'; }
        }
    }

    setLoading(true, mode === 'EDIT' ? "PATCHING..." : "BUILDING...");

    try {
        let resultFiles = {};
        let reasoning = "";
        let debugInfo = { mode: mode, patches: null, isFullReplace: false, apiResponse: null };

        if (mode === 'CREATE') {
            const res = await callOpenRouterCreate(apiKey, model, prompt);
            resultFiles = res.files;
            reasoning = res.reasoning;
            debugInfo.apiResponse = res.rawData;
            debugInfo.isFullReplace = true;
        } else {
            const res = await callOpenRouterEdit(apiKey, model, prompt, currentFiles);
            if (res.isFullReplace) {
                resultFiles = res.files || currentFiles;
            } else {
                resultFiles = applyFilePatches(currentFiles, res.patches);
            }
            reasoning = res.reasoning;
            debugInfo.patches = res.patches;
            debugInfo.apiResponse = res.rawData;
            debugInfo.isFullReplace = res.isFullReplace;
        }

        addRevision(proj, prompt, model, resultFiles, debugInfo, reasoning);

    } catch (err) {
        console.error(err);
        alert("Failed: " + err.message);
    } finally {
        setLoading(false);
    }
}

// =======================================================
//  API CALLS
// =======================================================
async function callOpenRouterCreate(key, model, prompt) {
    const sys = `You are an expert Web Developer.
    Generate a COMPLETE WEBSITE structure.
    Output a JSON object where keys are filenames (e.g. "index.html", "css/style.css") and values are the text content.
    ALWAYS include an "index.html".
    CAPABILITY: The site can use window.aurora.askAI(prompt, system) -> Promise<string> for features.
    Output ONLY valid JSON.`;
    
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://aurora.local", "X-Title": "Aurora" },
        body: JSON.stringify({ 
            model: model, response_format: { type: "json_object" },
            messages: [{role:"system",content:sys},{role:"user",content:`Build: ${prompt}`}] 
        })
    });
    return processResponse(res, false);
}

async function callOpenRouterEdit(key, model, prompt, currentFiles) {
    let contextStr = "";
    Object.keys(currentFiles).forEach(f => {
        const content = currentFiles[f];
        const safe = content.length > 20000 ? content.substring(0, 20000) + "\n...[truncated]" : content;
        contextStr += `--- FILE: ${f} ---\n${safe}\n\n`;
    });

    const sys = `Expert Code Editor.
    Output JSON with "patches".
    Format: { "patches": [ { "file": "index.html", "original_snippet": "...", "new_snippet": "..." } ] }
    To create file: "original_snippet": null.
    To delete file: "new_snippet": null.`;

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://aurora.local", "X-Title": "Aurora" },
        body: JSON.stringify({ 
            model: model, response_format: { type: "json_object" },
            messages: [{role:"system",content:sys},{role:"user",content:`FILES:\n${contextStr}\n\nREQ: ${prompt}`}] 
        })
    });
    return processResponse(res, true);
}

async function processResponse(res, isEdit) {
    if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || "API Error"); }
    const data = await res.json();
    let content = data.choices[0].message.content;
    let reasoning = data.choices[0].message.reasoning;
    if (!reasoning) { const m = content.match(/<think>([\s\S]*?)<\/think>/i); if (m) { reasoning = m[1].trim(); content = content.replace(/<think>[\s\S]*?<\/think>/i, ''); } }
    
    content = content.replace(/```json|```/g, '').trim();
    if (!content.startsWith('{') && content.trim().startsWith('<')) {
        return { files: { 'index.html': content }, rawData: data, reasoning };
    }

    try {
        const parsed = JSON.parse(content);
        if (isEdit) return { patches: parsed.patches || [], rawData: data, reasoning };
        else {
            const files = parsed.files || parsed;
            return { files: files, rawData: data, reasoning };
        }
    } catch (e) {
        console.warn("JSON Parse fail", content);
        throw new Error("Invalid JSON response.");
    }
}

function applyFilePatches(currentFiles, patches) {
    let newFiles = JSON.parse(JSON.stringify(currentFiles));
    patches.forEach(p => {
        if (!p.file) return;
        if (p.original_snippet === null) newFiles[p.file] = p.new_snippet;
        else if (p.new_snippet === null) delete newFiles[p.file];
        else if (newFiles[p.file] && newFiles[p.file].includes(p.original_snippet)) {
            newFiles[p.file] = newFiles[p.file].replace(p.original_snippet, p.new_snippet);
        }
    });
    return newFiles;
}

// =======================================================
//  AGENT CHAT
// =======================================================
function startNewChat() {
    if(!confirm("New chat?")) return;
    const proj = getActiveProject(); if(proj) { proj.agentHistory=[]; saveWorkspace(); renderAgentChat(); }
}

async function handleUserSubmit() {
    const input = $('#agent-input'), msg = input.val().trim(); if (!msg) return;
    const proj = getActiveProject(); if (!proj) return;
    addHistoryItem(proj, 'user', msg); input.val('');
    await triggerAgentResponse(proj);
}

async function triggerAgentResponse(proj) {
    let model = $('#model-select-value').val(); if (model === 'custom_mode') model = $('#model-custom-input').val().trim();
    
    let codeContext = "";
    const rev = proj.revisions.find(x => x.id === proj.selectedRevisionId);
    let files = (rev && rev.files) ? rev.files : (rev ? {'index.html':rev.html} : {});
    Object.keys(files).forEach(f => {
        const numbered = addLineNumbers(files[f]);
        codeContext += `--- FILE: ${f} ---\n${numbered.substring(0, 10000)}\n\n`;
    });

    const apiKey = await KeyManager.getEffectiveKey(); if (!apiKey) { addHistoryItem(proj, 'agent', "Key required."); return; }

    const c = $('#agent-chat-history'), streamId = 's-'+Date.now();
    c.append(`<div id="${streamId}" class="chat-message agent"><div class="chat-bubble">...</div></div>`); c.scrollTop(c[0].scrollHeight);
    const bubble = $(`#${streamId} .chat-bubble`);
    let fullText = "";

    try {
        const sys = `Aurora Agent. Expert Dev. CONTEXT:\n${codeContext}\nINSTRUCTIONS: Cite like [index.html:15]. Be concise.`;
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://aurora.local", "X-Title": "Aurora" },
            body: JSON.stringify({ 
                model: model, stream: true, 
                messages: [{role:"system",content:sys}, ...proj.agentHistory.map(m=>({role:m.role,content:m.text})).slice(-8)]
            })
        });

        const reader = res.body.getReader(), decoder = new TextDecoder();
        while(true) {
            const {done,value} = await reader.read(); if(done) break;
            const lines = decoder.decode(value,{stream:true}).split('\n');
            for(const line of lines) {
                if(line.startsWith('data: ') && line!=='data: [DONE]') {
                    try { const delta=JSON.parse(line.substring(6)).choices[0].delta.content; if(delta) { fullText+=delta; bubble.html(formatAgentText(fullText)); c.scrollTop(c[0].scrollHeight); } } catch(e){}
                }
            }
        }
        $(`#${streamId}`).remove(); addHistoryItem(proj, 'agent', fullText);
    } catch(e) { $(`#${streamId}`).remove(); addHistoryItem(proj, 'agent', "Error: "+e.message); }
}

function addHistoryItem(proj, role, text) {
    if(!proj.agentHistory) proj.agentHistory=[];
    proj.agentHistory.push({ role, text, timestamp: new Date().toLocaleTimeString() });
    saveWorkspace(); renderAgentChat();
}

function renderAgentChat() {
    const proj=getActiveProject(), c=$('#agent-chat-history'); c.empty();
    if(!proj||!proj.agentHistory||!proj.agentHistory.length) return c.html('<div class="text-center text-muted small mt-5">🤖 Agent Ready</div>');
    proj.agentHistory.forEach((msg,i) => {
        const edit = msg.role==='user' ? `<div class="btn-edit-msg">✎</div>` : '';
        c.append(`<div class="chat-message ${msg.role}" data-index="${i}"><div class="chat-bubble">${edit}${formatAgentText(msg.text)}</div><div class="chat-meta">${msg.timestamp}</div></div>`);
    });
    c.scrollTop(c[0].scrollHeight);
}

function formatAgentText(text) {
    if (!text) return "";
    let html = marked.parse(text); 
    return html.replace(/\[([\w\.\/\-]+):(\d+)\]/gi, (m, f, l) => `<span class="citation" data-file="${f}" data-line="${l}">${m}</span>`);
}

function addLineNumbers(code) { return code.split('\n').map((l,i)=>`${String(i+1).padStart(3)} | ${l}`).join('\n'); }

function enterEditMode(idx) {
    const p=getActiveProject(), m=p.agentHistory[idx], b=$(`.chat-message[data-index="${idx}"] .chat-bubble`);
    b.html(`<textarea class="agent-edit-textarea" rows="3">${m.text}</textarea><div class="edit-actions"><button class="btn btn-sm btn-outline-secondary btn-cancel-edit">Cancel</button><button class="btn btn-sm btn-primary-clean btn-save-edit">Save & Retry</button></div>`);
}
function saveEdit(idx, txt) {
    const p=getActiveProject(); if(!p||!txt.trim())return;
    p.agentHistory[idx].text=txt; p.agentHistory=p.agentHistory.slice(0,idx+1);
    saveWorkspace(); renderAgentChat(); triggerAgentResponse(p);
}

// =======================================================
//  UI UTILS
// =======================================================
function createNewProject() {
    const p = { id: Date.now(), title: "Untitled", description: "", revisions: [], agentHistory: [], selectedRevisionId: null, created: new Date().toLocaleDateString() };
    workspace.projects.unshift(p); saveWorkspace(); openProjectUI(p.id);
}

function deleteProject(id) {
    if(!confirm("Delete?")) return;
    workspace.projects = workspace.projects.filter(p => p.id !== id);
    if(workspace.activeProjectId === id) workspace.activeProjectId = null;
    saveWorkspace(); showDashboard();
}

function getActiveProject() { return workspace.projects.find(p=>p.id===workspace.activeProjectId); }

function showDashboard() {
    workspace.activeProjectId = null; saveWorkspace();
    $('#view-editor').addClass('d-none').removeClass('d-flex');
    $('#view-dashboard').removeClass('d-none').addClass('d-flex');
    const c = $('#projects-list'); c.empty();
    if(!workspace.projects.length) c.html('<div class="text-center text-muted mt-5">No projects.</div>');
    else workspace.projects.forEach(p => c.append(`<div class="project-card mb-3 p-3 border border-secondary rounded bg-dark position-relative" style="cursor:pointer;border-color:rgba(255,255,255,0.1)!important" data-id="${p.id}"><div class="d-flex justify-content-between align-items-start"><div><h6 class="text-white mb-1 fw-bold">${p.title||'Untitled'}</h6><div class="text-muted small">${p.revisions.length} revs • ${p.created}</div></div><button class="btn btn-sm btn-outline-danger btn-delete-project" style="z-index:2;font-size:0.7rem;padding:2px 6px;">✕</button></div></div>`));
    $('#preview-frame').attr('srcdoc', '<body style="background:#000;display:flex;justify-content:center;align-items:center;height:100vh;color:#444;font-family:sans-serif">Select Project</body>');
}

function openProjectUI(id) {
    const p = workspace.projects.find(x => x.id === id); 
    if(!p) return showDashboard();
    
    workspace.activeProjectId = id; 
    saveWorkspace();
    
    // Switch View
    $('#view-dashboard').addClass('d-none').removeClass('d-flex');
    $('#view-editor').removeClass('d-none').addClass('d-flex');
    
    // Populate Inputs
    $('#project-title').val(p.title);
    $('#project-desc').val(p.description);
    
    // Default to Generator Mode
    $('#mode-generator').prop('checked', true);
    enableGeneratorMode();
    
    // Module States
    if(!p.description) $('#mod-info').addClass('open'); 
    else $('#mod-info').removeClass('open');
    $('#mod-timeline').addClass('open');
    
    // Render History
    renderRevisions();
    
    // Scroll to bottom of history
    setTimeout(() => { 
        const c=$('#revisions-container'); 
        if(c[0]) c.scrollTop(c[0].scrollHeight); 
    }, 50);
    
    // Load Content
    if(p.selectedRevisionId) {
        selectRevision(p.selectedRevisionId);
    } else {
        // Only set srcdoc if we truly have no content
        $('#preview-frame').removeAttr('src');
        $('#preview-frame').attr('srcdoc', '<body style="background:white;display:flex;justify-content:center;align-items:center;height:100vh;color:#ccc;font-family:sans-serif;">Ready to generate...</body>');
    }
}

function closeProject() { showDashboard(); }

function addRevision(p, prompt, model, files, debug, reason) {
    const r = { id: Date.now(), timestamp: new Date().toLocaleTimeString(), prompt: prompt, model: model, files: files, debugInfo: debug, reasoning: reason };
    p.revisions.push(r); p.selectedRevisionId = r.id; saveWorkspace(); 
    renderRevisions(); renderFileList(files);
    const url = compileProject(files); loadFrame(url); scrollToBottom();
}

function deleteRevision(id) {
    if(!confirm("Delete rev?")) return;
    const p = getActiveProject();
    p.revisions = p.revisions.filter(r => r.id !== id);
    if(p.selectedRevisionId === id) {
        if(p.revisions.length) selectRevision(p.revisions[p.revisions.length-1].id);
        else { p.selectedRevisionId=null; loadFrame(''); }
    }
    saveWorkspace(); renderRevisions();
}

function selectRevision(id) {
    const p = getActiveProject(); 
    p.selectedRevisionId = id; 
    saveWorkspace();
    
    const r = p.revisions.find(x => x.id === id);
    if(r) {
        let f = r.files || { 'index.html': r.html };
        
        renderFileList(f);
        const url = compileProject(f);
        loadFrame(url);
        renderRevisions();
        
        // Highlight index.html by default in the file list
        $(`.file-item[data-file="index.html"]`).addClass('active');
    }
}

function renderRevisions() {
    const p=getActiveProject(); if(!p)return; const c=$('#revisions-container'); c.empty(); $('#rev-count').text(p.revisions.length);
    p.revisions.sort((a,b)=>a.id-b.id);
    if(!p.revisions.length) c.append('<div class="text-center text-muted small mt-5">No history</div>');
    else p.revisions.forEach(r => {
        const active=r.id===p.selectedRevisionId;
        let pre="", cls="";
        if(r.debugInfo) { 
            if(r.debugInfo.mode==='FIX') { pre="🚑 FIX. "; cls="text-danger fw-bold"; }
            else if(r.debugInfo.patches) { pre=`⚡ Patched ${r.debugInfo.patches.length}. `; cls="status-clickable"; }
            else if(r.debugInfo.isFullReplace) pre="★ New Build. ";
        }
        c.append(`<div class="revision-card ${active?'active':''} " data-id="${r.id}"><div class="rev-header"><span class="font-mono text-accent">${r.model.split('/')[1]||'model'}</span><span>${r.timestamp}</span></div><div class="rev-prompt" style="font-weight:500">${r.prompt}</div><div class="rev-response-preview"><span class="${cls}" data-action="view-patch">${pre}</span>${r.reasoning||"..."}</div><button class="btn-delete-rev">✕</button></div>`);
    });
    scrollToBottom();
}

function renderFileList(files) {
    const c = $('#file-list'); c.empty();
    Object.keys(files).forEach(f => c.append(`<button class="list-group-item file-item" data-file="${f}">📄 ${f}</button>`));
}

function scrollToBottom() { const c=$('#revisions-container'); if(c[0]) c.animate({scrollTop:c[0].scrollHeight},300); }
function loadFrame(url) { 
    const iframe = $('#preview-frame');
    iframe.removeAttr('srcdoc'); // <--- CRITICAL FIX: Remove legacy content
    iframe.attr('src', url); 
    $('#status-indicator').addClass('active'); 
}

function openCodeAtLine(file, line) {
    viewCodeForFile(file);
    setTimeout(() => {
        const m = new bootstrap.Modal(document.getElementById('codeModal')); m.show();
    }, 100);
}

function viewCode(e) {
    if(e) e.preventDefault();
    const proj=getActiveProject(), rev=proj.revisions.find(r=>r.id===proj.selectedRevisionId);
    let files=rev.files||{'index.html':rev.html};
    const s=$('#code-file-select'); s.empty();
    Object.keys(files).forEach(f=>s.append(`<option value="${f}">${f}</option>`));
    viewCodeForFile(Object.keys(files)[0]);
    new bootstrap.Modal(document.getElementById('codeModal')).show();
}

function viewCodeForFile(f) {
    const proj=getActiveProject(), rev=proj.revisions.find(r=>r.id===proj.selectedRevisionId);
    let files=rev.files||{'index.html':rev.html};
    $('#code-content').text(files[f] || "Error");
    $('#code-file-select').val(f);
    if(rev.reasoning) { $('#tab-btn-reasoning').show(); $('#reasoning-content').text(rev.reasoning); } else $('#tab-btn-reasoning').hide();
}

function showPatchDetails(id) {
    const p=getActiveProject(), r=p.revisions.find(x=>x.id===id); if(r&&r.debugInfo.patches) { 
        const c=$('#patch-list'); c.empty(); 
        r.debugInfo.patches.forEach((x,i)=>c.append(`<div class="patch-block"><div class="patch-header">File: ${x.file}</div><div class="diff-content"><div class="diff-old">-${(x.original_snippet||'NEW').replace(/</g,'&lt;')}</div><div class="diff-new">+${(x.new_snippet||'DEL').replace(/</g,'&lt;')}</div></div></div>`)); 
        new bootstrap.Modal(document.getElementById('patchModal')).show(); 
    } 
}

function exportSingleHTML(e) {
    e.preventDefault(); const p=getActiveProject(), r=p.revisions.find(x=>x.id===p.selectedRevisionId)||p.revisions[p.revisions.length-1]; if(!r) return;
    let files=r.files||{'index.html':r.html}; let content=files['index.html']||""; 
    Object.keys(files).forEach(f=>{ if(f!=='index.html') { const tag=f.endsWith('.css')?`<style>${files[f]}</style>`:`<script>${files[f]}</script>`; content+=tag; } }); 
    const b=new Blob([content],{type:'text/html'}), u=URL.createObjectURL(b), a=document.createElement('a'); a.href=u; a.download=`${(p.title||'app').replace(/[^a-z0-9]/gi,'_')}.html`; a.click(); 
}

function openInNewTab(e) { e.preventDefault(); const f=document.getElementById('preview-frame'); if(f.src) window.open(f.src, '_blank'); }
function showDebugInfo(e) { e.preventDefault(); const p=getActiveProject(), r=p.revisions.find(x=>x.id===p.selectedRevisionId); if(r) { $('#debug-content').text(JSON.stringify(r.debugInfo||{},null,2)); new bootstrap.Modal(document.getElementById('debugModal')).show(); } }
function setLoading(l,t="...") { if(l) { $('#loading-overlay').addClass('visible').find('.text-muted').text(t); $('#btn-generate').prop('disabled',true); } else { $('#loading-overlay').removeClass('visible'); $('#btn-generate').prop('disabled',false); } }

async function enhancePrompt() { const v=$('#prompt-input').val(); if(!v) return; const k=await KeyManager.getEffectiveKey(); if(!k)return; const r=await callAIHelper(k,"Prompt Eng.",v); $('#prompt-input').val(r); }
async function generateIdeas() { const p=getActiveProject(), k=await KeyManager.getEffectiveKey(); if(!k)return; const r=await callAIHelper(k,"PM. Suggest 3 features. JSON.", `Title:${p.title}`); const j=JSON.parse(r.replace(/```json|```/g,'')); const c=$('#idea-bubbles-container'); c.show().empty(); j.forEach(i=>c.append(`<div class="idea-bubble" data-prompt="${i.prompt}">+ ${i.label}</div>`)); }
async function handleAutoFix() {
    bootstrap.Modal.getInstance(document.getElementById('errorModal')).hide();
    const p=getActiveProject(); if(!p||!lastRuntimeError)return;
    const prompt=`Fix: ${lastRuntimeError.message}\nLine: ${lastRuntimeError.line}`;
    $('#prompt-input').val(prompt); $('#btn-generate').click();
}

async function callAIHelper(key, sys, user) { const res=await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{"Authorization":`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({model:"google/gemini-2.0-flash-exp:free",messages:[{role:"system",content:sys},{role:"user",content:user}]})}); return (await res.json()).choices[0].message.content; }

function loadWorkspace() { try { const s=localStorage.getItem(STORAGE_KEY); if(s) workspace=JSON.parse(s); } catch(e){} }
function saveWorkspace() { localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace)); }
function handleSaveKey() { const k=$('#user-api-key').val().trim(); if(k) { KeyManager.setUserKey(k); $('#user-api-key').val(''); bootstrap.Modal.getInstance(document.getElementById('settingsModal')).hide(); updateKeyStatus(); } }
function handleClearKey() { KeyManager.clearUserKey(); updateKeyStatus(); bootstrap.Modal.getInstance(document.getElementById('settingsModal')).hide(); }
async function updateKeyStatus() { const u=KeyManager.getUserKey(), d=await KeyManager.fetchDevKey(), s=$('#key-status'); if(u) s.html('<span class="text-success">● User Key</span>'); else if(d) s.html('<span class="text-warning">● Dev Key</span>'); else s.html('<span class="text-danger">● No Key</span>'); }

function initCustomSelector() {
    const w=document.querySelector('.custom-select-wrapper'), s=w.querySelector('.custom-select'), t=w.querySelector('.custom-select__trigger'), l=document.getElementById('current-model-label'), h=document.getElementById('model-select-value'), o=w.querySelectorAll('.custom-option'), ci=document.getElementById('model-custom-input'), tip=document.getElementById('aurora-tooltip');
    document.querySelectorAll('.info-icon').forEach(i=>{
        i.addEventListener('mouseenter',()=>{ const tx=i.getAttribute('data-tooltip'); if(!tx)return; tip.textContent=tx; tip.classList.add('visible'); const r=i.getBoundingClientRect(); tip.style.top=`${r.top+(r.height/2)-(tip.offsetHeight/2)}px`; tip.style.left=`${r.left-tip.offsetWidth-10}px`; });
        i.addEventListener('mouseleave',()=>{ tip.classList.remove('visible'); });
    });
    t.addEventListener('click',e=>{ s.classList.toggle('open'); e.stopPropagation(); }); document.addEventListener('click',e=>{ if(!s.contains(e.target)) s.classList.remove('open'); });
    o.forEach(op=>{ op.addEventListener('click',function(){ o.forEach(x=>x.classList.remove('selected')); this.classList.add('selected'); const v=this.getAttribute('data-value'), n=this.querySelector('.model-name'); l.textContent=n?n.textContent:this.textContent; h.value=v; s.classList.remove('open'); if(v==='custom_mode') { ci.classList.remove('d-none'); ci.focus(); } else ci.classList.add('d-none'); }); });
}