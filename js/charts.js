// Lightweight SVG charts (no dependencies, fully offline).
const escAttr = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function donut(items, total, centerTop, centerBottom) {
  const size = 200, sw = 18, c = size / 2, r = (size - sw) / 2, C = 2 * Math.PI * r;
  const gap = items.length > 1 ? 4 : 0;
  let offset = 0;
  const segs = items.map(it => {
    const len = total ? (it.value / total) * C : 0;
    const seg = `<circle r="${r}" cx="${c}" cy="${c}" fill="none" stroke="${escAttr(it.color)}" stroke-width="${sw}"
      stroke-dasharray="${Math.max(len - gap, 0.01)} ${C}" stroke-dashoffset="${-offset}" stroke-linecap="butt"/>`;
    offset += len;
    return seg;
  }).join('');
  return `<div class="donut">
    <svg viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <g transform="rotate(-90 ${c} ${c})">
        <circle r="${r}" cx="${c}" cy="${c}" fill="none" stroke="var(--track)" stroke-width="${sw}"/>
        ${segs}
      </g>
    </svg>
    <div class="donut-center"><div class="dc-top">${centerTop}</div><div class="dc-bottom">${centerBottom}</div></div>
  </div>`;
}

/** Grouped bars: income vs expense for each period. The last item is highlighted. */
export function bars(data) {
  const W = 320, H = 160, bottom = 22, top = 8;
  const max = Math.max(1, ...data.flatMap(d => [d.income, d.expense]));
  const gw = W / Math.max(data.length, 1);
  const bw = Math.min(12, gw / 4);
  const h = v => (v / max) * (H - bottom - top);
  const groups = data.map((d, i) => {
    const x = i * gw + gw / 2;
    const hi = h(d.income), he = h(d.expense);
    const cls = i === data.length - 1 ? 'current' : '';
    return `<g class="${cls}">
      <rect x="${x - bw - 2}" y="${H - bottom - hi}" width="${bw}" height="${Math.max(hi, 0)}" rx="${Math.min(4, bw / 2)}" fill="var(--income)"/>
      <rect x="${x + 2}" y="${H - bottom - he}" width="${bw}" height="${Math.max(he, 0)}" rx="${Math.min(4, bw / 2)}" fill="var(--spend)"/>
      <text x="${x}" y="${H - 6}" text-anchor="middle">${escAttr(d.label)}</text>
    </g>`;
  }).join('');
  return `<svg class="bars" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <line x1="0" x2="${W}" y1="${H - bottom}" y2="${H - bottom}" stroke="var(--sep)" stroke-dasharray="2 3"/>
    ${groups}
  </svg>`;
}
