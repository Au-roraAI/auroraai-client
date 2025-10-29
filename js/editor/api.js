async function getDefaultKeyFromDevFile() {
  const key = await getOpenRouterKey();
  if (!key) {
    throw new Error("No OpenRouter key. Add one in Settings.");
  }

  const sys = `You are AuroraAI's code generator. Return ONLY a compact JSON object with keys: html, css, js.\nRules:\n- html: full HTML body markup (no <html> wrapper).\n- css: CSS to style the page.\n- js: vanilla JS to run the page (no external fetches).\n- Do not include markdown fences or commentary.\n- Keep it functional + minimal.`;

  const body = {
    model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenRouter error: ${res.status} ${t}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return parseModelJSON(content);
}

function parseModelJSON(text) {
  // Try strict JSON first; then fallback to extracting the first {...}
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  // Fallback: treat as HTML only
  return { html: text, css: "", js: "" };
}

function makeHTMLDocument({ html, css, js }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><style>${
    css || ""
  }</style></head><body>${html || ""}<script>${
    js || ""
  }<\/script></body></html>`;
  const blob = new Blob([doc], { type: "text/html" });
  return URL.createObjectURL(blob);
}

async function exportZip(project) {
  // Light, dependency-free export: create a single HTML per active revision
  // plus a JSON manifest. (Replace later with JSZip if you want multi-file zips.)
  const latest = project.revisions[0];
  const manifest = {
    id: project.id,
    title: project.title,
    desc: project.desc,
    revisions: project.revisions.map((r) => ({
      id: r.id,
      ts: r.ts,
      prompt: r.prompt,
    })),
  };
  const files = [
    {
      name: `${project.title.replace(/[^a-z0-9_-]+/gi, "_")}_latest.html`,
      content: makeHTMLDocument(latest),
    },
    {
      name: `manifest.json`,
      content: URL.createObjectURL(
        new Blob([JSON.stringify(manifest, null, 2)], {
          type: "application/json",
        })
      ),
    },
  ];
  // We cannot truly zip without a lib; instead, open both in new tabs.
  files.forEach((f) => window.open(f.content, "_blank"));
}