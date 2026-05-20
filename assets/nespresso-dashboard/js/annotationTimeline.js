export function buildAnnotationTimeline(containerEl, sequence, totalDuration, colorFn) {
  containerEl.innerHTML = "";
  const W = containerEl.clientWidth || 300;

  sequence.forEach(item => {
    const xPct = (item.start / totalDuration) * 100;
    const wPct = (item.duration / totalDuration) * 100;
    const seg = document.createElement("div");
    seg.style.cssText = `
      position:absolute; left:${xPct}%; width:${wPct}%;
      height:100%; background:${colorFn(item.action)};
      opacity:0.75; cursor:pointer; box-sizing:border-box;
      border-right:1px solid rgba(255,255,255,0.3);
    `;
    seg.title = `${item.action} (${item.start.toFixed(1)}s – ${item.end.toFixed(1)}s)`;
    containerEl.appendChild(seg);
  });

  // Playhead indicator
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
