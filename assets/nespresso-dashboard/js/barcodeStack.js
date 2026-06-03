// barcodeStack.js
//
// Renders N color-coded annotation barcodes stacked vertically, one per session.
// Each barcode uses normalized time [0,1] so sessions of different durations
// align visually. The active session's barcode gets a blue thicker border;
// others have a thin neutral border.
//
// Clicking a segment fires onSegmentClick(sessionIndex, item) — the controller
// is responsible for switching the active video AND seeking to item.start.
//
// Public API:
//   buildBarcodeStack(containerEl, sessions, colorFn, options) → {
//     setActiveSession(sessionIndex),
//     updatePlayhead(sessionIndex, currentTime),
//     destroy()
//   }
//
//   sessions: [{ index, label, sequence, duration_s }, ...]
//   colorFn:  (action) => "#RRGGBB"
//   options:  { onSegmentClick: (sessionIndex, item) => void }

export function buildBarcodeStack(containerEl, sessions, colorFn, options = {}) {
  const onSegmentClick = options.onSegmentClick || (() => {});
  containerEl.innerHTML = "";
  containerEl.classList.add("barcode-stack");

  const rowElements = {}; // sessionIndex → row wrapper
  const playheads = {};   // sessionIndex → playhead element

  sessions.forEach((session) => {
    const row = document.createElement("div");
    row.className = "barcode-row";
    row.dataset.sessionIndex = String(session.index);

    const label = document.createElement("div");
    label.className = "barcode-row-label";
    label.textContent = session.label || `Session ${session.index + 1}`;
    row.appendChild(label);

    const strip = document.createElement("div");
    strip.className = "barcode-strip";

    const duration = session.duration_s || (session.sequence[session.sequence.length - 1]?.end || 1);

    session.sequence.forEach((item) => {
      const xPct = (item.start / duration) * 100;
      const wPct = Math.max((item.duration / duration) * 100, 0.25);

      const seg = document.createElement("div");
      seg.className = "barcode-segment";
      seg.style.cssText =
        `left:${xPct}%; width:${wPct}%; background:${colorFn(item.action)};`;
      seg.title = `${item.action}\n${item.start.toFixed(1)}s – ${item.end.toFixed(1)}s\nClick to seek`;

      seg.addEventListener("click", (e) => {
        e.stopPropagation();
        onSegmentClick(session.index, item);
      });

      strip.appendChild(seg);
    });

    // Playhead per row
    const playhead = document.createElement("div");
    playhead.className = "barcode-playhead";
    strip.appendChild(playhead);
    playheads[session.index] = playhead;

    // Click on strip background → seek that session
    strip.addEventListener("click", (e) => {
      if (e.target === strip) {
        const rect = strip.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        onSegmentClick(session.index, {
          start: pct * duration,
          end: pct * duration,
          action: "(strip-seek)",
          synthetic: true,
        });
      }
    });

    row.appendChild(strip);
    containerEl.appendChild(row);
    rowElements[session.index] = row;
  });

  function setActiveSession(sessionIndex) {
    Object.entries(rowElements).forEach(([idx, row]) => {
      row.classList.toggle("active", Number(idx) === sessionIndex);
    });
  }

  function updatePlayhead(sessionIndex, currentTime) {
    const session = sessions.find((s) => s.index === sessionIndex);
    if (!session) return;
    const duration = session.duration_s ||
      (session.sequence[session.sequence.length - 1]?.end || 1);
    const ph = playheads[sessionIndex];
    if (!ph) return;
    const pct = Math.min((currentTime / duration) * 100, 100);
    ph.style.left = pct + "%";
  }

  function destroy() {
    containerEl.innerHTML = "";
    containerEl.classList.remove("barcode-stack");
  }

  return { setActiveSession, updatePlayhead, destroy };
}