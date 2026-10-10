// Lightweight SVG charts (no dependencies, fully offline).
const escAttr = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/**
 * Donut with one arc per item. Each arc has a wide invisible twin so small slices stay tappable;
 * both carry data-action="slice" and data-i so the app can highlight the slice and its legend row.
 */
export function donut(items, total, centerTop, centerBottom) {
  const size = 200, sw = 18, c = size / 2, r = (size - sw - 16) / 2, C = 2 * Math.PI * r;
  const gap = items.length > 1 ? 4 : 0;
  let offset = 0;
  const arcs = items.map((it, i) => {
    const len = total ? (it.value / total) * C : 0;
    const dash = `stroke-dasharray="${Math.max(len - gap, 0.01)} ${C}" stroke-dashoffset="${-offset}"`;
    const hitDash = `stroke-dasharray="${Math.max(len, 0.01)} ${C}" stroke-dashoffset="${-offset}"`;
    offset += len;
    return {
      arc: `<circle class="arc" data-i="${i}" r="${r}" cx="${c}" cy="${c}" fill="none" stroke="${escAttr(it.color)}" stroke-width="${sw}" ${dash}/>`,
      hit: `<circle class="arc-hit" data-action="slice" data-i="${i}" r="${r}" cx="${c}" cy="${c}" fill="none" stroke="transparent" stroke-width="44" ${hitDash}/>`,
    };
  });
  return `<div class="donut">
    <svg viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <g transform="rotate(-90 ${c} ${c})">
        <circle r="${r}" cx="${c}" cy="${c}" fill="none" stroke="var(--track)" stroke-width="${sw}"/>
        ${arcs.map(a => a.arc).join('')}
        ${arcs.map(a => a.hit).join('')}
      </g>
    </svg>
    <button type="button" class="donut-center" data-action="slice" data-i="-1">
      <span class="dc-default"><span class="dc-top">${centerTop}</span><span class="dc-bottom">${centerBottom}</span></span>
      <span class="dc-sel" hidden></span>
    </button>
  </div>`;
}

/**
 * Grouped bars: income vs expense per period. Each period has a full-height transparent hit area
 * (data-action="bar", data-i) so a tap anywhere in its column selects it. The last item starts selected.
 */
export function bars(data) {
  const W = 320, H = 150, bottom = 22, top = 8;
  const max = Math.max(1, ...data.flatMap(d => [d.income, d.expense]));
  const gw = W / Math.max(data.length, 1);
  const bw = Math.min(12, gw / 4);
  const rx = Math.min(4, bw / 2);
  const h = v => (v / max) * (H - bottom - top);
  const groups = data.map((d, i) => {
    const x = i * gw + gw / 2;
    const hi = h(d.income), he = h(d.expense);
    const cls = i === data.length - 1 ? 'on' : '';
    return `<g class="bar-g ${cls}" data-i="${i}">
      <rect class="bar-bg" x="${i * gw + 3}" y="${top - 4}" width="${gw - 6}" height="${H - bottom - top + 4}" rx="10"/>
      <rect class="b" x="${x - bw - 2}" y="${H - bottom - hi}" width="${bw}" height="${Math.max(hi, 0)}" rx="${rx}" fill="var(--income)"/>
      <rect class="b" x="${x + 2}" y="${H - bottom - he}" width="${bw}" height="${Math.max(he, 0)}" rx="${rx}" fill="var(--spend)"/>
      <text x="${x}" y="${H - 6}" text-anchor="middle">${escAttr(d.label)}</text>
      <rect data-action="bar" data-i="${i}" x="${i * gw}" y="0" width="${gw}" height="${H}" fill="transparent"/>
    </g>`;
  }).join('');
  return `<svg class="bars" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <line x1="0" x2="${W}" y1="${H - bottom}" y2="${H - bottom}" stroke="var(--sep)"/>
    ${groups}
  </svg>`;
}

/**
 * Cumulative spending curve for the hero card.
 * `current` and `previous` are arrays of cumulative cents per day; `days` is the period length.
 */
export function spendCurve(current, previous, days) {
  const W = 320, H = 64, pad = 3;
  const max = Math.max(1, ...current, ...previous);
  const x = i => (days <= 1 ? 0 : (i / (days - 1)) * W);
  const y = v => H - pad - (v / max) * (H - pad * 2);
  // Smooth monotone-ish path using horizontal cubic handles.
  const path = arr => arr.map((v, i) => {
    if (i === 0) return `M${x(0)},${y(v)}`;
    const x0 = x(i - 1), x1 = x(i), mx = (x0 + x1) / 2;
    return `C${mx},${y(arr[i - 1])} ${mx},${y(v)} ${x1},${y(v)}`;
  }).join('');
  const cur = current.length ? path(current) : '';
  const last = current.length - 1;
  const area = current.length > 1 ? `${cur}L${x(last)},${H}L0,${H}Z` : '';
  return `<svg class="curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="curve-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3fc3a1" stop-opacity="0.35"/><stop offset="1" stop-color="#3fc3a1" stop-opacity="0"/>
    </linearGradient></defs>
    ${previous.length > 1 ? `<path d="${path(previous)}" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="1.5" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>` : ''}
    ${area ? `<path d="${area}" fill="url(#curve-fill)"/>` : ''}
    ${cur ? `<path d="${cur}" fill="none" stroke="#3fc3a1" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round"/>` : ''}
  </svg>
  ${current.length ? `<i class="curve-dot" style="left:${(x(last) / W) * 100}%;top:${(y(current[last]) / H) * 100}%"></i>` : ''}`;
}
