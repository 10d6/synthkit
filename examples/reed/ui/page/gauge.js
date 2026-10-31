// The wind gauge: follows the synth's "wind.pressure" mod source, and shows
// when the synth says the relief valve is open (the "wind.valve" message).
const INCHES = 3.6;   // full scale

export function setupGauge(sk, el) {
  const needle = el.querySelector(".gauge-needle");
  const readout = el.querySelector(".gauge-readout");
  const valve = el.querySelector(".gauge-valve");
  let shown = -1;
  sk.onMeter("wind.pressure", (p) => {
    if (!Number.isFinite(p)) return;
    const v = Math.round(p * 100) / 100;
    if (v === shown) return;
    shown = v;
    needle.style.transform = `rotate(${(v - 0.5) * 150}deg)`;
    readout.textContent = (v * INCHES).toFixed(1) + "″";
    el.setAttribute("aria-valuenow", (v * INCHES).toFixed(2));
  });
  sk.onMessage("wind.valve", (open) => { valve.hidden = !(open > 0.5); });
}
