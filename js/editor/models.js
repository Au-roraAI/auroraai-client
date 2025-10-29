// AuroraAI model catalog (minimal metadata)
const MODELS = [
  // Familiars (free in Aurora)
  {
    id: "openai/gpt-5-mini",
    label: "GPT-5 mini",
    group: "Your Familiars",
    badges: ["⚡", "💸"],
  },
  {
    id: "moonshot/kimi-k2",
    label: "Kimi K2",
    group: "Your Familiars",
    badges: ["💬"],
  },
  {
    id: "google/gemini-flash-2.5-thinking",
    label: "Gemini Flash 2.5 Thinking",
    group: "Your Familiars",
    badges: ["🧠", "⚡"],
  },
  {
    id: "anthropic/claude-4.5-haiku",
    label: "Haiku 4.5",
    group: "Your Familiars",
    badges: ["⚡"],
  },
  {
    id: "openai/gpt-5",
    label: "GPT-5",
    group: "Your Familiars",
    badges: ["💪"],
  },
  {
    id: "google/gemini-pro-2.5",
    label: "Gemini Pro 2.5",
    group: "Your Familiars",
    badges: ["📜"],
  },
  {
    id: "anthropic/claude-4.5-sonnet",
    label: "Sonnet 4.5",
    group: "Your Familiars",
    badges: ["🧠"],
  },
  {
    id: "anthropic/claude-4.5-sonnet-thinking",
    label: "Sonnet 4.5 Thinking",
    group: "Your Familiars",
    badges: ["🧠", "🧮"],
  },

  // Additions
  {
    id: "xai/grok-4-fast",
    label: "Grok 4 Fast",
    group: "Code Ninjas",
    badges: ["⚡", "💸"],
  },
  {
    id: "qwen/qwen-coder",
    label: "Qwen Coder",
    group: "Code Ninjas",
    badges: ["</>"],
  },
  {
    id: "mistralai/codestral",
    label: "Codestral",
    group: "Code Ninjas",
    badges: ["</>", "⚡"],
  },
  {
    id: "meta-llama/llama-3.1-70b-instruct",
    label: "Llama 3.1 70B Instruct",
    group: "Open & Friendly",
    badges: ["👐"],
  },
  {
    id: "deepseek/deepseek-r1-0528",
    label: "DeepSeek R1 (0528)",
    group: "Deep Thinkers",
    badges: ["🧠"],
  },
  {
    id: "ai21/jamba-1.5-large",
    label: "Jamba 1.5 Large",
    group: "Long-Context",
    badges: ["📜"],
  },
  {
    id: "google/gemma-2-27b-it",
    label: "Gemma 2 27B IT",
    group: "Open & Friendly",
    badges: ["👐", "💸"],
  },
];

function populateModelSelect(sel) {
  const groups = [...new Set(MODELS.map((m) => m.group))];
  $(sel).empty();
  groups.forEach((g) => {
    const $optgroup = $(`<optgroup label="${g}"></optgroup>`);
    MODELS.filter((m) => m.group === g).forEach((m) => {
      const badgeStr = (m.badges || []).join(" ");
      $optgroup.append(
        `<option value="${m.id}">${badgeStr ? badgeStr + " " : ""}${
          m.label
        }</option>`
      );
    });
    $(sel).append($optgroup);
  });
}
