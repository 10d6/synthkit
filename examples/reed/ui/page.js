// synthkit Reed's own page (API.md §9a). The kit calls mount() with the
// bridge (sk) and the element holding page.html; the page places the kit's
// parts where it wants them and draws the rest itself.
import { setupGauge } from "./page/gauge.js";
import { setupTreadles } from "./page/treadles.js";

export function mount(sk, root) {
  // The kit's preset bar, MIDI button and panic button, where page.html put a
  // data-mount; then its keyboard, without the tempo controls (an organ
  // doesn't need a clock).
  for (const el of root.querySelectorAll("[data-mount]:not(.keybed)")) sk.mount(el, el.dataset.mount);
  sk.mount(root.querySelector(".keybed"), "keyboard", { tempo: false });

  // The kit's knobs, as one panel described like a layout.json section.
  sk.mount(root.querySelector(".voicing"), "section", {
    title: "Voicing",
    controls: [
      { param: "reed.bright", label: "Brightness" },
      { param: "swell", label: "Knee swell" },
      { param: "room", label: "Room" },
      { param: "wind.helper", label: "Helper pump" },
      { param: "wind.size", label: "Reservoir" },
      { param: "master", label: "Volume" },
    ],
  });

  setupGauge(sk, root.querySelector(".gauge"));
  setupTreadles(sk, root.querySelector(".treadles"));
}
