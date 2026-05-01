export function buildLegend(legendStripEl, legendItems) {
  legendStripEl.innerHTML = "";
  const groups = Array.isArray(legendItems)
    ? { edge: legendItems }
    : legendItems;

  Object.entries(groups).forEach(([groupName, items]) => {
    const section = document.createElement("div");
    section.className = "legend-section";

    const title = document.createElement("div");
    title.className = "legend-section-title";
    title.textContent = groupName === "node" ? "Node" : "Edge";
    section.appendChild(title);

    const list = document.createElement("div");
    list.className = "legend-section-items";

    items.forEach((item) => {
      const el = document.createElement("div");
      el.className = "legend-item";

      if (item.type === "dot") {
        el.innerHTML =
          `<div class="legend-dot" style="background:${item.color}"></div>` +
          `<span>${item.label}</span>`;
      } else if (item.type === "line") {
        el.innerHTML =
          `<div class="legend-line${item.dashed ? " dashed" : ""}"></div>` +
          `<span>${item.label}</span>`;
      } else if (item.type === "badge1") {
        el.innerHTML =
          `<div class="legend-badge">1</div>` +
          `<span>${item.label}</span>`;
      } else if (item.type === "badge") {
        el.innerHTML =
          `<div class="legend-badge"></div>` +
          `<span>${item.label}</span>`;
      } else if (item.type === "ring") {
        el.innerHTML =
          `<div class="legend-ring">⟳</div>` +
          `<span>${item.label}</span>`;
      } else if (item.type === "arrow") {
        el.innerHTML =
          `<div class="legend-arrow">↔</div>` +
          `<span>${item.label}</span>`;
      } else if (item.type === "label") {
        el.innerHTML =
          `<div class="legend-label-sample">Aa</div>` +
          `<span>${item.label}</span>`;
      }

      list.appendChild(el);
    });

    section.appendChild(list);
    legendStripEl.appendChild(section);
  });
}
