import { DEFAULT_NODE_COLOR, VERB_COLORS, PHASE_COLORS } from "./config.js";

export function formatSeconds(seconds) {
  return Number(seconds || 0).toFixed(2) + " s";
}

export function nodeColor(actionId) {
  // Check if it's a phase name (for abstracted graph)
  if (PHASE_COLORS[actionId]) {
    return PHASE_COLORS[actionId];
  }

  // Otherwise, treat as action and extract verb
  const verb = actionId.split("(")[0].toLowerCase();
  return VERB_COLORS[verb] || DEFAULT_NODE_COLOR;
}

export function currentSequenceItem(sequence, currentTime) {
  return sequence.find((s) => currentTime >= s.start && currentTime < s.end) || null;
}

export function renderDataError(summaryPillEl, headerEl, message) {
  summaryPillEl.textContent = "Data unavailable";
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = message;
  headerEl.appendChild(div);
}
