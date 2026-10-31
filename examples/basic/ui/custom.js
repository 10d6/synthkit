// "Clear echoes": sends the synth a message (API.md §9b) to empty its delay,
// and shows the synth's answer. Messages aren't parameters: nothing is saved
// or automated, it just happens.
export function register(sk) {
  sk.widget("clearEchoes", (el, ctx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = "Clear echoes";
    btn.title = "Empty the delay right now";
    btn.addEventListener("click", () => ctx.send("delay.clear"));
    const note = document.createElement("span");
    note.className = "clear-note";
    note.setAttribute("aria-live", "polite");
    ctx.onMessage("delay.cleared", () => {
      note.textContent = "Cleared";
      clearTimeout(note.timer);
      note.timer = setTimeout(() => { note.textContent = ""; }, 1200);
    });
    el.append(btn, note);
  });
}
