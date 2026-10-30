// Following an external MIDI clock (24 ticks per quarter note, plus start,
// continue, stop and song position). Tempo comes from the tick spacing; the
// position is sent to the audio thread every beat, which absorbs small
// differences smoothly.

class MidiClock {
  constructor(app) {
    this.app = app;
    this.ticks = 0;
    this.last = 0;
    this.interval = 0;      // smoothed ms per tick
    this.running = false;
    this.lastTick = 0;
  }
  get bpm() { return this.interval > 0 ? 60000 / (this.interval * 24) : this.app.transport.bpm; }

  message(d, time) {
    const st = d[0];
    if (st === 0xf8) {
      if (this.last) {
        const dt = time - this.last;
        if (dt > 2 && dt < 200) this.interval = this.interval ? this.interval + (dt - this.interval) * 0.08 : dt;
      }
      this.last = time;
      this.lastTick = performance.now();
      if (!this.running) return;
      this.ticks++;
      if (this.ticks % 24 === 0) this.send();
    } else if (st === 0xfa) {           // start
      this.ticks = 0; this.running = true; this.send();
    } else if (st === 0xfb) {           // continue
      this.running = true; this.send();
    } else if (st === 0xfc) {           // stop
      this.running = false; this.send();
    } else if (st === 0xf2) {           // song position, in 16ths
      this.ticks = ((d[2] << 7) | d[1]) * 6;
      this.send();
    }
  }
  send() {
    const bpm = Math.round(this.bpm * 10) / 10;
    this.app.followClock(bpm, this.running, this.ticks / 24);
  }
}
