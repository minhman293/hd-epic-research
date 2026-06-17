// utils.js
//
// Shared helper functions used across graph.js, app.js, annotationTimeline.js.
//
// Delivery 6 update:
//   nodeColor() now uses getVerbColor() from config.js, which maps verbs to
//   their HD-EPIC canonical category and returns the category's color.
//   This replaces the old manual VERB_COLORS lookup.

import { getVerbColor, DEFAULT_NODE_COLOR } from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// nodeColor
//
// Given an action string like "take(cup)", "pour(milk)", or "S01", returns the
// appropriate color for the "Action category" color encoding.
//
// Action strings are in the form "verb(noun)" or just "verb".
// For Task Phases level the ID is already "S01", "S02", etc. — those get the
// default node color here; phase coloring is handled separately by
// getStepPhaseColor() in config.js.
// ─────────────────────────────────────────────────────────────────────────────

export function nodeColor(actionId) {
  if (!actionId) return DEFAULT_NODE_COLOR;
  return getVerbColor(actionId);
}

// ─────────────────────────────────────────────────────────────────────────────
// currentSequenceItem
//
// Given a sequence array and a playback time (seconds), returns the sequence
// item whose time window contains currentTime. Returns null if no item matches.
// ─────────────────────────────────────────────────────────────────────────────

export function currentSequenceItem(sequence, currentTime) {
  if (!sequence || sequence.length === 0) return null;
  for (const item of sequence) {
    if (currentTime >= item.start && currentTime < item.end) {
      return item;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// formatSeconds
//
// Format a number of seconds to a human-readable string.
// e.g. 63.4 → "1:03.4"
// ─────────────────────────────────────────────────────────────────────────────

export function formatSeconds(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || isNaN(totalSeconds)) {
    return "0.00 s";
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(2);
  const secPadded = seconds < 10 ? "0" + seconds : seconds;
  if (minutes === 0) return `${secPadded} s`;
  return `${minutes}:${secPadded}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// renderDataError
//
// Display a visible error message in the UI when data loading fails.
// Writes into the summaryPill element and adds an error banner below the header.
// ─────────────────────────────────────────────────────────────────────────────

export function renderDataError(summaryPillEl, headerEl, message) {
  if (summaryPillEl) {
    summaryPillEl.textContent = "Error loading data";
    summaryPillEl.style.background = "#fef2f2";
    summaryPillEl.style.borderColor = "#fecaca";
    summaryPillEl.style.color = "#b91c1c";
  }

  if (headerEl) {
    // Remove any previous error banner
    const existing = document.getElementById("dataErrorBanner");
    if (existing) existing.remove();

    const banner = document.createElement("div");
    banner.id = "dataErrorBanner";
    banner.style.cssText =
      "background:#fef2f2; border:1px solid #fecaca; color:#b91c1c; " +
      "padding:8px 14px; border-radius:8px; margin-top:8px; font-size:0.88rem;";
    banner.textContent = message;
    headerEl.insertAdjacentElement("afterend", banner);
  }

  console.error("[Dashboard]", message);
}