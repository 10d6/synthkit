// The treadles: hold one (pointer, or the arrow keys) to pump. Each press
// and release is a message to the synth (API.md §9b): not a parameter, so
// nothing is saved or automated.
const KEYS = { ArrowLeft: "left", ArrowRight: "right" };

export function setupTreadles(sk, el) {
  const buttons = new Map([...el.querySelectorAll(".treadle")].map((b) => [b.dataset.foot, b]));
  const held = new Set();

  function set(foot, down) {
    if (held.has(foot) === down) return;
    if (down) held.add(foot); else held.delete(foot);
    buttons.get(foot).setAttribute("aria-pressed", String(down));
    sk.send("treadle." + foot, down ? 1 : 0);
  }

  for (const [foot, b] of buttons) {
    b.addEventListener("pointerdown", (e) => { b.setPointerCapture(e.pointerId); set(foot, true); });
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(t, () => set(foot, false));
  }
  document.addEventListener("keydown", (e) => {
    if (KEYS[e.code] && !e.repeat && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); set(KEYS[e.code], true); }
  });
  document.addEventListener("keyup", (e) => { if (KEYS[e.code]) set(KEYS[e.code], false); });
  window.addEventListener("blur", () => { for (const f of [...held]) set(f, false); });
}
