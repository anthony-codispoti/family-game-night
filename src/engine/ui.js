import morphdom from 'morphdom';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Update the screen without wiping what someone is typing.
export function paint(root, html) {
  const next = document.createElement('div');
  next.id = root.id; next.className = root.className;
  next.innerHTML = html;
  morphdom(root, next, {
    onBeforeElUpdated(from, to) {
      if (from === document.activeElement && (from.tagName === 'INPUT' || from.tagName === 'TEXTAREA')) {
        // keep the typed value; still sync attributes like disabled
        to.value = from.value;
      }
      if (from.isEqualNode(to)) return false;
      return true;
    },
  });
}

// Each player gets a stable color by seat.
const COLORS = ['#FFC93C', '#FF5D8F', '#3DDC97', '#4CC9F0', '#B388FF', '#FF8A3D', '#F15BB5', '#9BE564', '#00BBF9', '#FEE440', '#F72585', '#80FFDB'];
export const colorFor = (seat) => COLORS[(seat ?? 0) % COLORS.length];

export function toast(msg, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.className = 'show ' + kind;
  clearTimeout(el._t); el._t = setTimeout(() => (el.className = ''), 2800);
}

export function vibrate(ms = 15) { try { navigator.vibrate?.(ms); } catch {} }
