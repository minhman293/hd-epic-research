export function buildAnnotationTimeline(containerEl, sequence, totalDuration, colorFn, options = {}) {
  containerEl.innerHTML = "";
  const onSegmentClick = options.onSegmentClick || (() => {});

  sequence.forEach((item, idx) => {
    const xPct = (item.start / totalDuration) * 100;
    const wPct = Math.max((item.duration / totalDuration) * 100, 0.3); // min width so micro-actions stay clickable
    const seg = document.createElement("div");
    seg.className = "annotation-segment";
    seg.dataset.index = String(idx);
    seg.dataset.action = item.action;
    seg.style.cssText = `
      position:absolute; left:${xPct}%; width:${wPct}%;
      height:100%; background:${colorFn(item.action)};
      opacity:0.75; cursor:pointer; box-sizing:border-box;
      border-right:1px solid rgba(255,255,255,0.3);
      transition: opacity 0.15s;
    `;
    seg.title = `${item.action}\n${item.start.toFixed(1)}s – ${item.end.toFixed(1)}s\nClick to seek`;

    seg.addEventListener("click", (e) => {
      e.stopPropagation();
      onSegmentClick(item, idx);
    });

    seg.addEventListener("mouseenter", () => { seg.style.opacity = "1"; });
    seg.addEventListener("mouseleave", () => { seg.style.opacity = "0.75"; });

    containerEl.appendChild(seg);
  });

  const playhead = document.createElement("div");
  playhead.id = "annotationPlayhead";
  playhead.style.cssText = `
    position:absolute; top:0; width:2px; height:100%;
    background:#1f2937; pointer-events:none; z-index:10;
  `;
  containerEl.appendChild(playhead);
  return playhead;
}

export function updateAnnotationPlayhead(playheadEl, currentTime, totalDuration) {
  const pct = Math.min((currentTime / totalDuration) * 100, 100);
  playheadEl.style.left = pct + "%";
}
