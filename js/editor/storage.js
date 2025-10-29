const LS_KEYS = {
PROJECT: 'aurora_project',
OPENROUTER: 'openrouter_key'
};


function loadProject(){
try{ return JSON.parse(localStorage.getItem(LS_KEYS.PROJECT)) || null }catch(e){ return null }
}
function saveProject(p){
localStorage.setItem(LS_KEYS.PROJECT, JSON.stringify(p));
}
function newProject(){
return {
id: `proj_${Date.now()}`,
title: 'Untitled Aurora',
desc: '',
revisions: [] // {id, ts, prompt, html, css, js}
};
}
function addRevision(project, rev){
project.revisions.unshift(rev); // newest first
saveProject(project);
}