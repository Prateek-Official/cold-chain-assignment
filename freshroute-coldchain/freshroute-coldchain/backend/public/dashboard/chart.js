// Dependency-free SVG line chart. Returns an HTML string.
// points:  [{ ts, tempC }] sorted by ts
// markers: [{ ts, label, kind }]  vertical event lines (driver events, alerts)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmmss = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function lineChart({ points, threshold, markers = [], width = 760, height = 260 }) {
  if (!points.length) return '<div class="empty">No readings yet</div>';

  const pad = { l: 44, r: 14, t: 22, b: 26 };
  const xs = points.map((p) => Date.parse(p.ts));
  const mk = markers.map((m) => ({ ...m, ms: Date.parse(m.ts) }));
  const x0 = Math.min(xs[0], ...mk.map((m) => m.ms));
  const x1 = Math.max(xs[xs.length - 1], ...mk.map((m) => m.ms), x0 + 1000);
  const temps = points.map((p) => p.tempC);
  const yMin = Math.floor(Math.min(...temps, threshold - 4) - 1);
  const yMax = Math.ceil(Math.max(...temps, threshold + 1) + 1);

  const X = (ms) => pad.l + ((ms - x0) / (x1 - x0)) * (width - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (height - pad.t - pad.b);

  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(p.tempC).toFixed(1)}`).join(' ');

  const yTicks = [];
  const step = Math.max(1, Math.round((yMax - yMin) / 5));
  for (let v = yMin; v <= yMax; v += step) yTicks.push(v);
  const xTicks = Array.from({ length: 5 }, (_, i) => x0 + ((x1 - x0) * i) / 4);

  const hot = points
    .map((p, i) => (p.tempC > threshold ? `<circle cx="${X(xs[i]).toFixed(1)}" cy="${Y(p.tempC).toFixed(1)}" r="2.6" class="pt-hot"/>` : ''))
    .join('');

  const markerSvg = mk
    .map((m, i) => {
      const x = X(m.ms).toFixed(1);
      const y = 12 + (i % 2) * 11; // stagger labels so neighbours don't collide
      return `<g class="mk mk-${esc(m.kind || 'info')}"><line x1="${x}" x2="${x}" y1="${pad.t}" y2="${height - pad.b}"/><text x="${x}" y="${y}" text-anchor="middle">${esc(m.label)}</text></g>`;
    })
    .join('');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Temperature chart">
    ${yTicks.map((v) => `<line class="grid" x1="${pad.l}" x2="${width - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="tick" x="${pad.l - 6}" y="${Y(v) + 3}" text-anchor="end">${v}°</text>`).join('')}
    ${xTicks.map((ms) => `<text class="tick" x="${X(ms)}" y="${height - 8}" text-anchor="middle">${hhmmss(ms)}</text>`).join('')}
    <rect class="danger-zone" x="${pad.l}" y="${pad.t}" width="${width - pad.l - pad.r}" height="${Math.max(0, Y(threshold) - pad.t)}"/>
    <line class="limit" x1="${pad.l}" x2="${width - pad.r}" y1="${Y(threshold)}" y2="${Y(threshold)}"/>
    <text class="limit-label" x="${width - pad.r}" y="${Y(threshold) - 4}" text-anchor="end">${threshold}°C limit</text>
    <path class="line" d="${path}"/>
    ${hot}
    ${markerSvg}
  </svg>`;
}
