// swimlane.js
//
// Renders a step-based swimlane for one session. Each recipe step gets a
// horizontal lane on a real time axis. Every atomic action that fell into a
// step's time window is drawn as a colored sub-segment bar in that step's
// lane, with width = duration and color from colorFn (same encoding as the
// existing barcode). Actions that don't belong to any step go into a dashed
// "Secondary" lane at the bottom.
//
// Public API:
//   buildSwimlane(containerEl, payload, colorFn, options) → {
//     updatePlayhead(currentTime),
//     destroy(),
//   }
//
//   payload:  the per-session JSON ({ steps, sequence, ... })
//   colorFn:  (action) => "#RRGGBB"
//   options:
//     onSegmentClick:  (item) => void
//     stepLabelLookup: { stepId → label }

import { resolveStepLabel, getStepPhaseColor, UNASSIGNED_PHASE_COLOR } from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";

const LANE_HEIGHT    = 28;
const LANE_GAP       = 4;
const AXIS_HEIGHT    = 28;
const LABEL_WIDTH    = 170;
const RIGHT_PAD      = 16;
const TOP_PAD        = 8;
const BOTTOM_PAD     = 8;
const LABEL_MAX_CHARS = 25;
const MIN_BAR_PX     = 2;        // minimum bar width so sub-second actions stay visible

function mk(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) {
        el.setAttribute(k, String(attrs[k]));
      }
    }
  }
  return el;
}

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "\u2026" : text;
}

function chooseTickInterval(duration) {
  if (duration <= 30)   return 5;
  if (duration <= 120)  return 10;
  if (duration <= 300)  return 30;
  if (duration <= 900)  return 60;
  if (duration <= 1800) return 300;
  return 600;
}

function formatTick(seconds, interval) {
  if (interval < 60) return seconds + "s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? m + "m" + s + "s" : m + "m";
}

// Extract local step id: "P01_R01_S01" → "S01"
function localStepId(fullId) {
  if (!fullId) return null;
  const parts = String(fullId).split("_");
  const last = parts[parts.length - 1];
  return (last && /^S\d+$/.test(last)) ? last : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main builder
// ─────────────────────────────────────────────────────────────────────────────

export function buildSwimlane(containerEl, payload, colorFn, options) {
  if (!options) options = {};
  const onSegmentClick = options.onSegmentClick || function () {};
  const stepLabelLookup = options.stepLabelLookup || {};
  const colorMode       = options.colorMode || "category";

  containerEl.innerHTML = "";
  containerEl.classList.add("swimlane-wrap");

  const steps    = payload.steps    || [];
  const sequence = payload.sequence || [];

  // ── empty state ──────────────────────────────────────────────────────────
  if (sequence.length === 0) {
    var empty = document.createElement("div");
    empty.className = "swimlane-empty";
    empty.textContent = "No actions in this session.";
    containerEl.appendChild(empty);
    return { updatePlayhead: function () {}, destroy: function () { containerEl.innerHTML = ""; } };
  }

  // ── build lane list ──────────────────────────────────────────────────────
  var laneIds = [];
  steps.forEach(function (s) {
    var local = localStepId(s.id);
    if (local) laneIds.push(local);
  });
  // If steps array was empty (shouldn't happen), fall back to sequence step_ids
  if (laneIds.length === 0) {
    var seen = {};
    sequence.forEach(function (item) {
      var local = localStepId(item.step_id);
      if (local && !seen[local]) { laneIds.push(local); seen[local] = true; }
    });
    laneIds.sort();
  }

  // Check for secondary actions
  var SECONDARY = "__secondary__";
  var hasSecondary = sequence.some(function (item) {
    return !item.is_primary || !item.step_id;
  });
  if (hasSecondary) laneIds.push(SECONDARY);

  var laneCount = laneIds.length;

  // ── time extent ──────────────────────────────────────────────────────────
  var tMax = 0;
  sequence.forEach(function (item) { if (item.end > tMax) tMax = item.end; });
  if (tMax <= 0) tMax = 1;

  // ── bucket items into lanes ──────────────────────────────────────────────
  var itemsByLane = {};
  laneIds.forEach(function (id) { itemsByLane[id] = []; });

  sequence.forEach(function (item) {
    if (item.is_primary && item.step_id) {
      var local = localStepId(item.step_id);
      if (local && itemsByLane[local]) {
        itemsByLane[local].push(item);
      } else if (itemsByLane[SECONDARY]) {
        itemsByLane[SECONDARY].push(item);
      }
    } else {
      if (itemsByLane[SECONDARY]) {
        itemsByLane[SECONDARY].push(item);
      }
    }
  });

  // ── SVG dimensions ───────────────────────────────────────────────────────
  var svgHeight = TOP_PAD + AXIS_HEIGHT
    + laneCount * (LANE_HEIGHT + LANE_GAP) - LANE_GAP + BOTTOM_PAD;

  var svg = mk("svg", { "class": "swimlane-svg" });
  svg.style.display = "block";
  svg.style.width   = "100%";
  svg.style.height  = svgHeight + "px";
  containerEl.appendChild(svg);

  // ── internal refs for playhead ───────────────────────────────────────────
  var _playhead = null;
  var _tScale   = null;

  // ── render (called on mount and resize) ──────────────────────────────────
  function render() {
    var totalWidth = containerEl.clientWidth || 800;
    var chartWidth = totalWidth - LABEL_WIDTH - RIGHT_PAD;
    if (chartWidth < 50) return;

    svg.setAttribute("viewBox", "0 0 " + totalWidth + " " + svgHeight);
    svg.innerHTML = "";

    var chartLeft = LABEL_WIDTH;

    function tScale(t) {
      return chartLeft + (t / tMax) * chartWidth;
    }
    _tScale = tScale;

    // ── time axis ────────────────────────────────────────────────────────
    var axisY = TOP_PAD + AXIS_HEIGHT - 4;
    svg.appendChild(mk("line", {
      x1: chartLeft, y1: axisY, x2: chartLeft + chartWidth, y2: axisY,
      "class": "swimlane-axis-line"
    }));

    var tickInterval = chooseTickInterval(tMax);
    for (var t = 0; t <= tMax; t += tickInterval) {
      var tx = tScale(t);
      if (tx < chartLeft - 1 || tx > chartLeft + chartWidth + 1) continue;
      svg.appendChild(mk("line", {
        x1: tx, y1: axisY - 4, x2: tx, y2: axisY,
        "class": "swimlane-axis-tick"
      }));
      var tickLabel = mk("text", {
        x: tx, y: axisY - 8,
        "class": "swimlane-axis-label",
        "text-anchor": "middle"
      });
      tickLabel.textContent = formatTick(t, tickInterval);
      svg.appendChild(tickLabel);
    }

    // ── lanes ────────────────────────────────────────────────────────────
    for (var i = 0; i < laneCount; i++) {
      var laneId = laneIds[i];
      var y = TOP_PAD + AXIS_HEIGHT + i * (LANE_HEIGHT + LANE_GAP);
      var isSec = laneId === SECONDARY;

      // background
      var bg = mk("rect", {
        x: chartLeft, y: y, width: chartWidth, height: LANE_HEIGHT,
        rx: 4,
        "class": isSec ? "swimlane-bg-secondary" : "swimlane-bg-primary"
      });
      (function (bgEl) {
        bgEl.addEventListener("click", function (e) {
          var rect = svg.getBoundingClientRect();
          var svgX = (e.clientX - rect.left) * (totalWidth / rect.width);
          var clickT = ((svgX - chartLeft) / chartWidth) * tMax;
          if (clickT >= 0 && clickT <= tMax) {
            onSegmentClick({
              start: clickT, end: clickT,
              action: "(swimlane-seek)", synthetic: true
            });
          }
        });
      })(bg);
      svg.appendChild(bg);

      // label
      var label = mk("text", {
        x: LABEL_WIDTH - 8,
        y: y + LANE_HEIGHT / 2,
        "class": isSec ? "swimlane-label-secondary" : "swimlane-label-text",
        "text-anchor": "end",
        "dominant-baseline": "central"
      });
      if (isSec) {
        label.textContent = "Secondary";
      } else {
        var resolved = resolveStepLabel(laneId, stepLabelLookup);
        label.textContent = truncate(resolved || laneId, LABEL_MAX_CHARS);
      }
      svg.appendChild(label);

      // action bars
      var items = itemsByLane[laneId];
      for (var j = 0; j < items.length; j++) {
        var item = items[j];
        var bx = tScale(item.start);
        var bw = Math.max(tScale(item.end) - bx, MIN_BAR_PX);
        var actionKey = item.raw_action || item.action;
        // In phase mode, color by LANE membership (not by the action's
        // majority-vote step) so each lane shows one consistent color.
        // This prevents a revisited action from carrying its "home step"
        // color into a different lane — which would falsely suggest that
        // step is active at that time.
        var barFill;
        if (colorMode === "phase") {
          barFill = isSec ? UNASSIGNED_PHASE_COLOR : getStepPhaseColor(laneId);
        } else {
          barFill = colorFn(actionKey);
        }
        var bar = mk("rect", {
          x: bx, y: y + 1, width: bw, height: LANE_HEIGHT - 2,
          rx: 2,
          "class": "swimlane-bar",
          fill: barFill
        });
        // tooltip via <title>
        var tip = mk("title");
        tip.textContent = actionKey
          + "\n" + item.start.toFixed(1) + "s \u2013 " + item.end.toFixed(1)
          + "s (" + item.duration.toFixed(1) + "s)"
          + "\nStep: " + (item.step_id || "none")
          + "\nClick to seek";
        bar.appendChild(tip);

        (function (clickItem) {
          bar.addEventListener("click", function (e) {
            e.stopPropagation();
            onSegmentClick(clickItem);
          });
        })(item);

        svg.appendChild(bar);
      }
    }

    // ── playhead ─────────────────────────────────────────────────────────
    var phY1 = TOP_PAD + AXIS_HEIGHT;
    var phY2 = phY1 + laneCount * (LANE_HEIGHT + LANE_GAP) - LANE_GAP;
    _playhead = mk("line", {
      x1: chartLeft, y1: phY1, x2: chartLeft, y2: phY2,
      "class": "swimlane-playhead"
    });
    svg.appendChild(_playhead);
  }

  // Initial render
  render();

  // Re-render on container resize so the time axis rescales
  var ro = new ResizeObserver(function () { render(); });
  ro.observe(containerEl);

  // ── public API ─────────────────────────────────────────────────────────
  function updatePlayhead(currentTime) {
    if (!_playhead || !_tScale) return;
    var x = _tScale(Math.min(currentTime, tMax));
    _playhead.setAttribute("x1", x);
    _playhead.setAttribute("x2", x);
  }

  function destroy() {
    ro.disconnect();
    containerEl.innerHTML = "";
    containerEl.classList.remove("swimlane-wrap");
  }

  return { updatePlayhead: updatePlayhead, destroy: destroy };
}