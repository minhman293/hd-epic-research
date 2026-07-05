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

const LANE_HEIGHT    = 44;
const LANE_GAP       = 4;
var PREP_TRACK_RATIO = 0.32;   // upper slice of each primary lane
var TRACK_GAP = 1;             // px between tracks
const AXIS_HEIGHT    = 28;
const LABEL_WIDTH    = 170;
const RIGHT_PAD      = 16;
const TOP_PAD        = 8;
const BOTTOM_PAD     = 8;
const LABEL_MAX_CHARS = 25;
const MIN_BAR_PX     = 3;        // minimum bar width so sub-second actions stay visible
const ZOOM_MIN_SPAN  = 5;

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
  const hasPrepPhase = sequence.some(function (item) {
    return item.phase === "prep";
  });

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

  if (hasPrepPhase) {
    var prepLegend = document.createElement("div");
    prepLegend.className = "swimlane-legend";
    prepLegend.style.display = "flex";
    prepLegend.style.alignItems = "center";
    prepLegend.style.gap = "14px";
    prepLegend.style.margin = "0 0 6px 0";
    prepLegend.style.fontSize = "12px";
    prepLegend.style.color = "#475569";
    prepLegend.style.flexWrap = "wrap";

    function addLegendItem(opacity, labelText) {
      var item = document.createElement("div");
      item.style.display = "inline-flex";
      item.style.alignItems = "center";
      item.style.gap = "6px";
      var swatch = document.createElement("span");
      swatch.style.display = "inline-block";
      swatch.style.width = "14px";
      swatch.style.height = "10px";
      swatch.style.boxSizing = "border-box";
      swatch.style.background = "#334155";
      swatch.style.opacity = String(opacity);
      swatch.style.border = "1px solid #334155";
      item.appendChild(swatch);
      var text = document.createElement("span");
      text.textContent = labelText;
      item.appendChild(text);
      prepLegend.appendChild(item);
    }

    addLegendItem(0.45, "upper track = preparation");
    addLegendItem(1.0, "lower track = execution");
    containerEl.appendChild(prepLegend);
  }

  var laneCount = laneIds.length;

  // ── time extent ──────────────────────────────────────────────────────────
  var tMax = 0;
  sequence.forEach(function (item) { if (item.end > tMax) tMax = item.end; });
  if (tMax <= 0) tMax = 1;
  var viewStart = 0;
  var viewEnd = tMax;

  // ── duration color quantiles (for `duration` colorMode) -------------
  var _durs = sequence.map(function (it) { return it.duration; })
                      .filter(function (d) { return d > 0; })
                      .sort(function (a, b) { return a - b; });
  function _q(p) {
    if (_durs.length === 0) return 0;
    return _durs[Math.min(_durs.length - 1, Math.floor(p * _durs.length))];
  }
  var _durQs   = [_q(0.2), _q(0.4), _q(0.6), _q(0.8)];
  var DUR_RAMP = ["#E1F5EE", "#9FE1CB", "#5DCAA5", "#1D9E75", "#085041"];
  function durationColor(d) {
    for (var k = 0; k < _durQs.length; k++) if (d <= _durQs[k]) return DUR_RAMP[k];
    return DUR_RAMP[4];
  }

  // ── duration legend (show when swimlane is in `duration` mode) -------
  if (colorMode === "duration") {
    var durLegend = document.createElement("div");
    durLegend.className = "swimlane-legend";
    durLegend.style.display = "flex";
    durLegend.style.alignItems = "center";
    durLegend.style.gap = "10px";
    durLegend.style.margin = "0 0 6px 0";
    durLegend.style.fontSize = "12px";
    durLegend.style.color = "#475569";

    var rampWrap = document.createElement("div");
    rampWrap.style.display = "inline-flex";
    rampWrap.style.gap = "8px";

    var qLabels = [
      "≤" + Math.round(_durQs[0]) + "s",
      "≤" + Math.round(_durQs[1]) + "s",
      "≤" + Math.round(_durQs[2]) + "s",
      "≤" + Math.round(_durQs[3]) + "s",
      ">" + Math.round(_durQs[3]) + "s"
    ];

    for (var ri = 0; ri < DUR_RAMP.length; ri++) {
      var item = document.createElement("div");
      item.style.display = "inline-flex";
      item.style.alignItems = "center";
      item.style.gap = "6px";
      var sw = document.createElement("span");
      sw.style.display = "inline-block";
      sw.style.width = "12px";
      sw.style.height = "12px";
      sw.style.background = DUR_RAMP[ri];
      sw.style.border = "1px solid #334155";
      item.appendChild(sw);
      var text = document.createElement("span");
      text.textContent = qLabels[ri];
      item.appendChild(text);
      rampWrap.appendChild(item);
    }
    durLegend.appendChild(rampWrap);
    containerEl.appendChild(durLegend);
  }

  function setViewRange(nextStart, nextEnd) {
    var span = Math.max(ZOOM_MIN_SPAN, Math.min(tMax, nextEnd - nextStart));
    var start = Math.max(0, nextStart);
    var end = start + span;
    if (end > tMax) {
      end = tMax;
      start = Math.max(0, end - span);
    }
    viewStart = start;
    viewEnd = end;
  }

  // ── bucket items into lanes ──────────────────────────────────────────────
  var itemsByLane = {};
  laneIds.forEach(function (id) { itemsByLane[id] = []; });

  sequence.forEach(function (item) {
    if ((item.is_primary || item.phase === "prep") && item.step_id) {
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
    var clipId = "swimlane-clip-" + (containerEl.id || "default");
    var defs = mk("defs");
    var clip = mk("clipPath", { id: clipId });
    clip.appendChild(mk("rect", {
      x: chartLeft, y: 0, width: chartWidth, height: svgHeight
    }));
    defs.appendChild(clip);
    svg.appendChild(defs);

    var chartG = mk("g", { "clip-path": "url(#" + clipId + ")" });

    function tScale(t) {
      return chartLeft + ((t - viewStart) / (viewEnd - viewStart)) * chartWidth;
    }
    function tInvert(px) {
      return viewStart + ((px - chartLeft) / chartWidth) * (viewEnd - viewStart);
    }
    _tScale = tScale;

    // ── time axis ────────────────────────────────────────────────────────
    var axisY = TOP_PAD + AXIS_HEIGHT - 4;
    svg.appendChild(mk("line", {
      x1: chartLeft, y1: axisY, x2: chartLeft + chartWidth, y2: axisY,
      "class": "swimlane-axis-line"
    }));

    var tickInterval = chooseTickInterval(viewEnd - viewStart);
    for (var t = Math.ceil(viewStart / tickInterval) * tickInterval; t <= viewEnd; t += tickInterval) {
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
      var prepY = y;
      var prepH = isSec ? 0 : Math.max(0, Math.round(LANE_HEIGHT * PREP_TRACK_RATIO) - TRACK_GAP);
      var execY = isSec ? y : y + Math.round(LANE_HEIGHT * PREP_TRACK_RATIO);
      var execH = isSec ? LANE_HEIGHT : LANE_HEIGHT - Math.round(LANE_HEIGHT * PREP_TRACK_RATIO);

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
          var clickT = tInvert(svgX);
          if (clickT >= viewStart && clickT <= viewEnd) {
            onSegmentClick({
              start: clickT, end: clickT,
              action: "(swimlane-seek)", synthetic: true
            });
          }
        });
      })(bg);
      svg.appendChild(bg);

      if (!isSec) {
        svg.appendChild(mk("line", {
          x1: chartLeft, y1: execY, x2: chartLeft + chartWidth, y2: execY,
          "class": "swimlane-track-separator",
          stroke: "#cbd5d1",
          "stroke-width": 0.5,
          "stroke-dasharray": "2 3"
        }));
      }

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
        var display = (resolved && resolved !== laneId) ? laneId + " \u2013 " + resolved : laneId;
        label.textContent = truncate(display, LABEL_MAX_CHARS);
      }
      svg.appendChild(label);

      // action bars
      var items = itemsByLane[laneId];
      for (var j = 0; j < items.length; j++) {
        var item = items[j];
        var bx = tScale(item.start);
        var bw = Math.max(tScale(item.end) - bx, MIN_BAR_PX);
        var actionKey = item.raw_action || item.action;
        var isPrep = item.phase === "prep" && !isSec;
        var barColor;
        if (colorMode === "step" || colorMode === "phase") {
          barColor = (!isSec && item.step_id)
            ? getStepPhaseColor(localStepId(item.step_id) || item.step_id)
            : UNASSIGNED_PHASE_COLOR;
        } else if (colorMode === "duration") {
          barColor = durationColor(item.duration);
        } else {
          barColor = colorFn(actionKey);
        }
        var barY = isPrep ? prepY + 2 : execY + 3;
        var barH = isPrep ? Math.max(prepH - 4, 6) : Math.max(execH - 6, 6);
        var bar = mk("rect", {
          x: bx, y: barY, width: bw, height: barH,
          rx: 2,
          "class": "swimlane-bar",
          fill: barColor,
          "fill-opacity": (isPrep && colorMode !== "duration") ? 0.45 : 1.0,
          stroke: isPrep ? barColor : "none",
          "stroke-width": isPrep ? 1 : 0
        });
        // tooltip via <title>
        var tip = mk("title");
        tip.textContent = actionKey
          + "\n" + item.start.toFixed(1) + "s \u2013 " + item.end.toFixed(1)
          + "s (" + item.duration.toFixed(1) + "s)"
          + "\nStep: " + (item.step_id || "none")
          + "\nClick to seek";
        bar.appendChild(tip);

        if (isPrep) {
          (function (hoverItem, hoverLaneId, hoverBarY, hoverBarH, hoverColor, hoverBx, hoverBw, hoverExecY) {
            var hoverGroup = null;

            function clearHover() {
              if (hoverGroup && hoverGroup.parentNode) {
                hoverGroup.parentNode.removeChild(hoverGroup);
              }
              hoverGroup = null;
            }

            function showHoverConnector() {
              clearHover();
              var laneItems = itemsByLane[hoverLaneId] || [];
              var execItem = null;
              for (var k = 0; k < laneItems.length; k++) {
                var candidate = laneItems[k];
                if (candidate.phase !== "exec") continue;
                if (candidate.start >= hoverItem.end && (!execItem || candidate.start < execItem.start)) {
                  execItem = candidate;
                }
              }
              if (!execItem) return;

              var execBx = tScale(execItem.start);
              var execBarY = hoverExecY + 3;

              hoverGroup = mk("g", { "class": "swimlane-hover-connector" });
              hoverGroup.appendChild(mk("line", {
                x1: hoverBx + hoverBw,
                y1: hoverBarY + hoverBarH,
                x2: execBx,
                y2: execBarY,
                stroke: hoverColor,
                "stroke-width": 1.2,
                "stroke-dasharray": "4 3",
                "stroke-opacity": 0.85
              }));
              var midX = (hoverBx + hoverBw + execBx) / 2;
              var midY = (hoverBarY + hoverBarH + execBarY) / 2 - 4;
              var gapText = mk("text", {
                x: midX,
                y: midY,
                "text-anchor": "middle",
                "font-size": "9px",
                fill: hoverColor,
                "paint-order": "stroke",
                stroke: "white",
                "stroke-width": 3
              });
              gapText.textContent = "gap " + Math.max(0, Math.round(execItem.start - hoverItem.end)) + "s";
              hoverGroup.appendChild(gapText);
              chartG.appendChild(hoverGroup);
            }

            bar.addEventListener("mouseenter", showHoverConnector);
            bar.addEventListener("mouseleave", clearHover);
          })(item, laneId, barY, barH, barColor, bx, bw, execY);
        }

        (function (clickItem) {
          bar.addEventListener("click", function (e) {
            e.stopPropagation();
            onSegmentClick(clickItem);
          });
        })(item);

        chartG.appendChild(bar);
      }
    }

    svg.appendChild(chartG);

    // ── playhead ─────────────────────────────────────────────────────────
    var phY1 = TOP_PAD + AXIS_HEIGHT;
    var phY2 = phY1 + laneCount * (LANE_HEIGHT + LANE_GAP) - LANE_GAP;
    _playhead = mk("line", {
      x1: chartLeft, y1: phY1, x2: chartLeft, y2: phY2,
      "class": "swimlane-playhead"
    });
    chartG.appendChild(_playhead);
  }

  // Initial render
  render();

  var raf = null;
  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = null;
      render();
    });
  }

  svg.addEventListener("wheel", function (e) {
    e.preventDefault();
    var rect = svg.getBoundingClientRect();
    var px = (e.clientX - rect.left) * (svg.viewBox.baseVal.width / rect.width);
    var span = viewEnd - viewStart;
    var factor = e.deltaY < 0 ? 1 / 1.15 : 1.15;
    var newSpan = Math.min(tMax, Math.max(ZOOM_MIN_SPAN, span * factor));
    var anchor = viewStart + ((px - LABEL_WIDTH) / (rect.width - LABEL_WIDTH - RIGHT_PAD)) * span;
    var frac = (anchor - viewStart) / span;
    setViewRange(anchor - frac * newSpan, anchor - frac * newSpan + newSpan);
    scheduleRender();
  }, { passive: false });

  var dragT0 = null, dragMoved = false;
  svg.addEventListener("pointerdown", function (e) {
    dragT0 = e.clientX; dragMoved = false;
  });
  svg.addEventListener("pointermove", function (e) {
    if (dragT0 === null) return;
    var dx = e.clientX - dragT0;
    if (Math.abs(dx) < 4 && !dragMoved) return;
    dragMoved = true;
    var rect = svg.getBoundingClientRect();
    var dt = (dx / (rect.width - LABEL_WIDTH - RIGHT_PAD)) * (viewEnd - viewStart);
    var span = viewEnd - viewStart;
    setViewRange(viewStart - dt, viewStart - dt + span);
    dragT0 = e.clientX;
    scheduleRender();
  });
  svg.addEventListener("pointerup", function () { dragT0 = null; });
  svg.addEventListener("dblclick", function () {
    setViewRange(0, tMax);
    scheduleRender();
  });

  // Re-render on container resize so the time axis rescales
  var ro = new ResizeObserver(function () { render(); });
  ro.observe(containerEl);

  // ── public API ─────────────────────────────────────────────────────────
  function updatePlayhead(currentTime) {
    if (!_playhead || !_tScale) return;
    if (currentTime < viewStart || currentTime > viewEnd) {
      _playhead.setAttribute("opacity", "0");
      return;
    }
    _playhead.setAttribute("opacity", "1");
    var x = _tScale(currentTime);
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