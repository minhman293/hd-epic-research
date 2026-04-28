export function buildLegend(legendStripEl, legendItems) {
  legendStripEl.innerHTML = "";
  legendItems.forEach((item) => {
    const el = document.createElement("div");
    el.className = "legend-item";

    if (item.type === "dot") {
      el.innerHTML =
        `<div class="legend-dot" style="background:${item.color}"></div>` +
        `<span>${item.label}</span>`;
    } else {
      el.innerHTML =
        `<div class="legend-line${item.dashed ? " dashed" : ""}"></div>` +
        `<span>${item.label}</span>`;
    }

    legendStripEl.appendChild(el);
  });
}
