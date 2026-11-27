// In-page dialogs: the unsaved-changes warning, naming a copy, Preferences.
// The page draws its own rather than using confirm() / prompt(), which a
// plugin's web view may not show.
//
// skDialog({ title, message, body, buttons, cancel }) shows one and resolves
// with the value of the button pressed (or `cancel` for Escape / a click
// outside). A button: { label, value, primary, danger, run }. `run(value)`, if
// given, may return false to keep the dialog open (a field to fix first).
// Keys pressed inside a dialog stay there (the computer keys don't play).

let skDialogOpen = null;

function skDialog({ title, message = "", body = null, buttons = [], cancel = "cancel", className = "" }) {
  if (skDialogOpen) skDialogOpen.close(cancel);
  return new Promise((resolve) => {
    const before = document.activeElement;
    const id = "sk-dialog-title";
    const btns = buttons.map((b) => h("button", {
      type: "button",
      class: "btn" + (b.primary ? " btn-primary" : "") + (b.danger ? " btn-danger" : ""),
      "data-value": b.value,
      onclick: () => { if (b.run && b.run(b.value) === false) return; close(b.value); },
    }, b.label));
    const box = h("div", { class: "sk-dialog " + className, role: "dialog", "aria-modal": "true", "aria-labelledby": id },
      h("h2", { class: "sk-dialog-title", id, text: title }),
      message ? h("p", { class: "sk-dialog-msg", text: message }) : null,
      body,
      h("div", { class: "sk-dialog-buttons" }, ...btns));
    const back = h("div", { class: "sk-dialog-back" }, box);
    const stop = (e) => e.stopPropagation();
    box.addEventListener("keyup", stop);
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); close(cancel); return; }
      if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type !== "checkbox") {
        const primary = btns.find((b, i) => buttons[i].primary);
        if (primary) { e.preventDefault(); primary.click(); }
        return;
      }
      if (e.key === "Tab") {   // keep focus inside
        const f = [...box.querySelectorAll("button, input, select, textarea")].filter((el) => !el.disabled && el.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    back.addEventListener("pointerdown", (e) => { if (e.target === back) close(cancel); });
    let done = false;
    function close(value) {
      if (done) return;
      done = true;
      back.remove();
      skDialogOpen = null;
      if (before && before.focus && document.contains(before)) before.focus();
      resolve(value);
    }
    skDialogOpen = { close };
    document.body.append(back);
    const field = box.querySelector("input:not([type=checkbox]), select");
    const primary = btns.find((b, i) => buttons[i].primary) || btns[0];
    (field || primary || box).focus();
    if (field && field.select) field.select();
  });
}

// A name not yet taken: "Warm Pad", else "Warm Pad 2", "Warm Pad 3"… (a name
// already ending in a number counts on from it).
function skUniqueName(name, taken) {
  name = String(name || "").trim() || "Untitled";
  if (!taken(name)) return name;
  const m = /^(.*?) (\d+)$/.exec(name);
  const base = m ? m[1] : name;
  for (let k = m ? Number(m[2]) + 1 : 2; ; k++) if (!taken(`${base} ${k}`)) return `${base} ${k}`;
}

// Settings for the whole page, kept like the theme (this browser, or the
// plugin's settings file): not part of any sound.
const SK_PREFS_KEY = "synthkit:prefs";
const SK_PREFS_DEFAULT = { warnUnsaved: true };
const skPrefs = {
  get() { return { ...SK_PREFS_DEFAULT, ...(skStore.get(SK_PREFS_KEY, {}) || {}) }; },
  set(change) { return skStore.set(SK_PREFS_KEY, { ...this.get(), ...change }); },
};

// Preferences: Cancel / Save.
function skPreferences() {
  const p = skPrefs.get();
  const warn = h("input", { type: "checkbox", id: "sk-pref-warn" });
  warn.checked = !!p.warnUnsaved;
  const body = h("div", { class: "sk-prefs" },
    h("label", { class: "sk-check" }, warn, h("span", {},
      h("strong", { text: "Warn before leaving unsaved changes" }),
      h("span", { class: "sk-hint", text: "When you pick another sound (or Init, or import one) after changing this one." }))));
  return skDialog({
    title: "Preferences",
    body,
    className: "sk-dialog-prefs",
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Save", value: "save", primary: true, run: () => { skPrefs.set({ warnUnsaved: warn.checked }); } },
    ],
  });
}
