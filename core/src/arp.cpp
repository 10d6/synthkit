#include "arp.h"

#include <algorithm>
#include <cmath>

namespace sk::detail {

namespace {
struct Rate { const char* name; double beats; };
const Rate kRates[] = {
    {"1/1", 4.0},   {"1/2", 2.0},     {"1/4.", 1.5},   {"1/4", 1.0},    {"1/4T", 2.0 / 3.0}, {"1/8.", 0.75},
    {"1/8", 0.5},   {"1/8T", 1.0 / 3.0}, {"1/16.", 0.375}, {"1/16", 0.25}, {"1/16T", 1.0 / 6.0}, {"1/32", 0.125},
};
constexpr int kRateCount = static_cast<int>(std::size(kRates));
constexpr int kRateDefault = 9;  // 1/16

// A key pressed this soon after a grid point plays at once (on the grid it
// just missed) instead of waiting for the next one.
constexpr double kGraceSeconds = 0.04;
// Keys let go of this close to the last one still belong to the phrase's tail.
constexpr double kTailSeconds = 0.06;
}  // namespace

// ---------------------------------------------------------------- patterns

ArpBank arpDefaultBank() {
  ArpBank b;
  // Pattern 1: a broken chord to start from (rows 0 2 1 2, then up an octave
  // and back). The others start empty.
  ArpPattern& p = b.patterns[0];
  p.steps = 8;
  const int rows[8] = {0, 2, 1, 2, 0, 3, 1, 2};
  for (int i = 0; i < 8; ++i) p.notes[static_cast<std::size_t>(p.count++)] = ArpPatternNote{static_cast<int16_t>(i), static_cast<int16_t>(rows[i]), 1, static_cast<uint8_t>(i % 4 == 0 ? 112 : 88), 100};
  return b;
}

void arpSaveBank(const ArpBank& b, Json& j) {
  Json pats = Json::array();
  for (const ArpPattern& p : b.patterns) {
    Json pj = Json::object();
    pj["steps"] = p.steps;
    Json notes = Json::array();
    for (int i = 0; i < p.count; ++i) {
      const ArpPatternNote& n = p.notes[static_cast<std::size_t>(i)];
      Json nj = Json::array();
      nj.push(n.step); nj.push(n.row); nj.push(n.len); nj.push(n.vel);
      if (n.chance < 100) nj.push(n.chance);
      notes.push(nj);
    }
    pj["notes"] = notes;
    pats.push(pj);
  }
  j["patterns"] = pats;
}

void arpLoadBank(const Json& j, ArpBank& b) {
  const Json& pats = j["patterns"];
  if (!pats.isArray()) return;
  ArpBank out;   // patterns a patch leaves out are empty
  int pi = 0;
  for (const Json& pj : pats.items()) {
    if (pi >= kArpPatterns) break;
    ArpPattern& p = out.patterns[static_cast<std::size_t>(pi++)];
    p.steps = std::clamp(static_cast<int>(pj["steps"].number(16)), 1, kArpMaxSteps);
    p.count = 0;
    for (const Json& nj : pj["notes"].items()) {
      if (p.count >= kArpMaxPatternNotes) break;
      if (!nj.isArray() || nj.size() < 2) continue;
      ArpPatternNote n;
      n.step = static_cast<int16_t>(std::clamp(static_cast<int>(nj[0].number()), 0, kArpMaxSteps - 1));
      if (n.step >= p.steps) continue;
      n.row = static_cast<int16_t>(std::clamp(static_cast<int>(std::lround(nj[1].number())), kArpRowLow, kArpRowHigh));
      n.len = static_cast<int16_t>(std::clamp(static_cast<int>(nj[2].number(1)), 1, kArpMaxSteps));
      n.vel = static_cast<uint8_t>(std::clamp(static_cast<int>(nj[3].number(100)), 1, 127));
      n.chance = static_cast<uint8_t>(std::clamp(static_cast<int>(nj[4].number(100)), 0, 100));
      p.notes[static_cast<std::size_t>(p.count++)] = n;
    }
  }
  b = out;
}

const std::vector<std::string>& arpRateNames() {
  static const std::vector<std::string> n = [] {
    std::vector<std::string> v;
    for (auto& r : kRates) v.emplace_back(r.name);
    return v;
  }();
  return n;
}

void Arp::addParams(ParamBuilder& b) {
  const std::string g = "Arpeggiator", ge = "Arp Note Envelope", gp = "Arp Phrase Envelope";
  P.on = b.count(); b.addKit("arp.on").name("Arp").toggle().def(0).group(g);
  P.mode = b.count(); b.addKit("arp.mode").name("Arp Mode").choices({"Up", "Down", "Up/Down", "Down/Up", "As Played", "Random", "Chord", "Pattern"}).group(g);
  P.octaves = b.count(); b.addKit("arp.octaves").name("Arp Octaves").range(1, 4).integer().def(1).group(g);
  P.rate = b.count(); b.addKit("arp.rate").name("Arp Rate").choices(arpRateNames()).def(kRateDefault).group(g);
  P.gate = b.count(); b.addKit("arp.gate").name("Arp Gate").range(5, 200).def(50).unit("%").group(g);
  P.swing = b.count(); b.addKit("arp.swing").name("Arp Swing").range(0, 100).def(0).unit("%").group(g);
  P.latch = b.count(); b.addKit("arp.latch").name("Arp Latch").toggle().def(0).group(g);
  P.sync = b.count(); b.addKit("arp.sync").name("Arp Sync").choices({"Grid", "Key"}).group(g);
  P.velMode = b.count(); b.addKit("arp.velMode").name("Arp Velocity").choices({"Played", "Fixed"}).group(g);
  P.velFixed = b.count(); b.addKit("arp.velFixed").name("Arp Fixed Velocity").range(1, 127).integer().def(100).group(g);
  P.pattern = b.count(); b.addKit("arp.pattern").name("Arp Pattern").range(1, kArpPatterns).integer().def(1).group(g);
  P.envMode = b.count(); b.addKit("arp.envMode").name("Arp Envelope").choices({"Off", "Multiply", "Replace"}).def(ArpEnvMultiply).group(ge);
  P.a = b.count(); b.addKit("arp.attack").name("Arp Attack").range(0.0005, 10).log().def(0.002).unit("s").group(ge);
  P.d = b.count(); b.addKit("arp.decay").name("Arp Decay").range(0.001, 20).log().def(0.3).unit("s").group(ge);
  P.s = b.count(); b.addKit("arp.sustain").name("Arp Sustain").range(0, 1).def(1).group(ge);
  P.r = b.count(); b.addKit("arp.release").name("Arp Release").range(0.002, 20).log().def(0.05).unit("s").group(ge);
  P.pa = b.count(); b.addKit("arp.phraseAttack").name("Phrase Attack").range(0.0005, 10).log().def(0.002).unit("s").group(gp);
  P.pd = b.count(); b.addKit("arp.phraseDecay").name("Phrase Decay").range(0.001, 20).log().def(0.5).unit("s").group(gp);
  P.ps = b.count(); b.addKit("arp.phraseSustain").name("Phrase Sustain").range(0, 1).def(1).group(gp);
  P.pr = b.count(); b.addKit("arp.phraseRelease").name("Phrase Release").range(0.002, 20).log().def(0.05).unit("s").group(gp);
}

void Arp::prepare(double sampleRate, int maxBlock) {
  sr_ = sampleRate;
  phraseBuf_.assign(static_cast<std::size_t>(std::max(maxBlock, 1)), 0.f);
  phraseEnv_.prepare(static_cast<float>(sr_));
  reset();
}

void Arp::reset() {
  nChord_ = 0;
  nOffs_ = 0;
  down_.fill(0);
  sustained_.fill(false);
  pedal_ = gateOn_ = running_ = false;
  stepIndex_ = 0;
  stepPos_ = 0;
  lastRandom_ = -1;
  allOff_ = false;
  phraseEnv_.reset();
}

float Arp::stepPosAt(int sample) const {
  float v = stepPosStart_;
  for (int i = 0; i < nStepMarks_ && stepMarks_[static_cast<std::size_t>(i)].first <= sample; ++i) v = stepMarks_[static_cast<std::size_t>(i)].second;
  return v;
}

int Arp::choice(int i) const { return i >= 0 ? static_cast<int>(std::lround(store_->get(i))) : 0; }

double Arp::stepLen() const {
  return kRates[std::clamp(choice(P.rate), 0, kRateCount - 1)].beats;
}

int Arp::sampleOf(Beats b) const {
  double pos = std::floor((b - blockStart_) * spb_ + 1e-6);
  return pos < 0 ? 0 : pos >= frames_ ? frames_ : static_cast<int>(pos);
}

int Arp::heldKeys() const {
  int n = 0;
  for (int i = 0; i < 128; ++i) n += down_[static_cast<std::size_t>(i)] > 0 || sustained_[static_cast<std::size_t>(i)];
  return n;
}

void Arp::advanceEnv(int to) {
  for (; envPos_ < to; ++envPos_) phraseBuf_[static_cast<std::size_t>(envPos_)] = phraseEnv_.next();
}

void Arp::emit(MidiEvent e, int sample) {
  e.sample = std::clamp(sample, 0, frames_ - 1);
  e.beat = blockStart_ + e.sample / spb_;
  if (*outCount_ >= outCap_) { ++*dropped_; return; }
  out_[(*outCount_)++] = e;
}

void Arp::flushOffs(int sample, bool all) {
  int k = 0;
  for (int i = 0; i < nOffs_; ++i) {
    const Off& o = offs_[static_cast<std::size_t>(i)];
    int s = sampleOf(o.beat);
    if (all || s <= sample) {
      MidiEvent e = NoteOff{o.note, o.channel};
      e.arp = true;
      emit(e, all ? sample : s);
    } else {
      offs_[static_cast<std::size_t>(k++)] = o;
    }
  }
  nOffs_ = k;
}

void Arp::clearAll(bool hard) {
  flushOffs(envPos_, true);
  nChord_ = 0;
  down_.fill(0);
  sustained_.fill(false);
  running_ = false;
  gateOn_ = false;
  phraseEnv_.gate(false);
  if (hard) phraseEnv_.reset();
}

void Arp::process(const MidiEvent* in, int nIn, MidiEvent* out, int& outCount, int outCap, int& dropped,
                  const ParamStore& store, Beats blockStart, double spb, int frames, const Transport& t, bool jumped) {
  store_ = &store;
  out_ = out;
  outCount_ = &outCount;
  outCap_ = outCap;
  dropped_ = &dropped;
  blockStart_ = blockStart;
  spb_ = spb;
  frames_ = frames;
  t_ = &t;
  envPos_ = 0;
  stepPosStart_ = stepPos_;
  nStepMarks_ = 0;
  phraseEnv_.set(get(P.pa), get(P.pd), get(P.ps), get(P.pr));

  if (allOff_) { allOff_ = false; clearAll(false); }
  const bool on = get(P.on) >= 0.5f;
  if (!on) {
    if (wasOn_) {
      // Turned off: stop, and let the keys still down sound as played keys.
      flushOffs(0, true);
      running_ = false;
      gateOn_ = false;
      phraseEnv_.gate(false);
      for (int n = 0; n < 128; ++n)
        if (down_[static_cast<std::size_t>(n)] > 0)
          for (int i = 0; i < nChord_; ++i)
            if (chord_[static_cast<std::size_t>(i)].note == n) {
              const Entry& c = chord_[static_cast<std::size_t>(i)];
              emit(NoteOn{c.note, c.vel, c.channel}, 0);
              break;
            }
      nChord_ = 0;
      down_.fill(0);
      sustained_.fill(false);
      wasOn_ = false;
    }
    for (int i = 0; i < nIn; ++i) {
      if (outCount >= outCap) { ++dropped; continue; }
      out[outCount++] = in[i];
    }
    advanceEnv(frames);
    return;
  }
  wasOn_ = true;

  if (jumped) {
    flushOffs(0, true);
    if (running_ && choice(P.sync) == ArpSyncGrid) {
      double len = stepLen();
      gridBeat_ = std::ceil((blockStart - 1e-9) / len) * len;
      stepBeat_ = gridBeat_;
    } else if (running_) {
      gridBeat_ = stepBeat_ = blockStart;
    }
  }
  const bool latched = get(P.latch) >= 0.5f;
  if (wasLatched_ && !latched) unlatch();
  wasLatched_ = latched;

  int ei = 0;
  for (;;) {
    int nextEv = ei < nIn ? std::clamp(in[ei].sample, 0, frames - 1) : frames;
    int nextOff = frames;
    for (int i = 0; i < nOffs_; ++i) nextOff = std::min(nextOff, sampleOf(offs_[static_cast<std::size_t>(i)].beat));
    int nextStep = running_ ? sampleOf(stepBeat_) : frames;
    int at = std::min({nextEv, nextOff, nextStep});
    if (at >= frames) break;
    advanceEnv(at);
    // Same sample: note-offs, then keys (so a step hears them), then the step.
    if (nextOff == at) { flushOffs(at, false); continue; }
    if (nextEv == at) { handle(in[ei++]); continue; }
    // A phrase whose envelope has finished stops; its tail is over.
    if (!gateOn_ && phraseEnv_.idle()) { running_ = false; nChord_ = 0; continue; }
    step(at);
  }
  advanceEnv(frames);
  if (running_ && !gateOn_ && phraseEnv_.idle()) { running_ = false; nChord_ = 0; }
}

void Arp::handle(const MidiEvent& e) {
  if (e.isNoteOn() && !e.arp) {
    const int n = std::clamp(e.note, 0, 127);
    if (heldKeys() == 0) newPhrase(e);
    else addNote(e);
    if (down_[static_cast<std::size_t>(n)] < 255) ++down_[static_cast<std::size_t>(n)];
    sustained_[static_cast<std::size_t>(n)] = false;
    return;
  }
  if (e.isNoteOff() && !e.arp) {
    const int n = std::clamp(e.note, 0, 127);
    if (down_[static_cast<std::size_t>(n)] == 0) { emit(e, e.sample); return; }  // a key played before the arp came on
    if (--down_[static_cast<std::size_t>(n)] == 0) {
      if (pedal_) sustained_[static_cast<std::size_t>(n)] = true;
      else keyUp(n);
    }
    return;
  }
  if (e.isCC(64)) {
    bool p = e.value >= 0.5f;
    if (pedal_ && !p) {
      pedal_ = false;
      for (int n = 0; n < 128; ++n)
        if (sustained_[static_cast<std::size_t>(n)]) { sustained_[static_cast<std::size_t>(n)] = false; keyUp(n); }
    }
    pedal_ = p;
  } else if (e.isCC(123) || e.isCC(120)) {
    clearAll(e.isCC(120));
  }
  emit(e, e.sample);
}

void Arp::newPhrase(const MidiEvent& e) {
  nChord_ = 0;
  addNote(e);
  gateOn_ = true;
  phraseEnv_.gate(true);
  ++phraseCount_;
  rng_.seed(dsp::hashSeed(phraseCount_, 0xA4Fu, static_cast<uint64_t>(e.note)));
  lastRandom_ = -1;
  start(blockStart_ + std::clamp(e.sample, 0, frames_ - 1) / spb_);
}

void Arp::addNote(const MidiEvent& e) {
  for (int i = 0; i < nChord_; ++i) {
    Entry& c = chord_[static_cast<std::size_t>(i)];
    if (c.note == e.note) {
      if (c.gone) c.order = ++orderCounter_;
      c.gone = false;
      c.vel = e.vel;
      c.channel = e.channel;
      return;
    }
  }
  if (nChord_ >= kMaxNotes) return;
  chord_[static_cast<std::size_t>(nChord_++)] = Entry{e.note, e.vel, e.channel, ++orderCounter_, false, 0};
}

void Arp::keyUp(int note) {
  if (get(P.latch) >= 0.5f) return;
  const Beats now = blockStart_ + envPos_ / spb_;
  if (heldKeys() > 0) {
    for (int i = 0; i < nChord_; ++i) {
      Entry& c = chord_[static_cast<std::size_t>(i)];
      if (c.note == note && !c.gone) { c.gone = true; c.goneAt = now; }
    }
    return;
  }
  // The last key: the chord, with keys let go of just before, plays on as
  // the phrase's tail while the phrase envelope releases.
  const Beats window = t_->seconds(kTailSeconds);
  for (int i = 0; i < nChord_; ++i) {
    Entry& c = chord_[static_cast<std::size_t>(i)];
    if (c.gone && now - c.goneAt <= window) c.gone = false;
  }
  gateOn_ = false;
  phraseEnv_.gate(false);
}

void Arp::unlatch() {
  // Notes no longer held go; with none held, the chord becomes the tail.
  if (heldKeys() == 0) {
    if (gateOn_) { gateOn_ = false; phraseEnv_.gate(false); }
    return;
  }
  int k = 0;
  for (int i = 0; i < nChord_; ++i) {
    const Entry& c = chord_[static_cast<std::size_t>(i)];
    const int n = std::clamp(c.note, 0, 127);
    if (down_[static_cast<std::size_t>(n)] > 0 || sustained_[static_cast<std::size_t>(n)]) chord_[static_cast<std::size_t>(k++)] = c;
  }
  nChord_ = k;
}

void Arp::start(Beats keyBeat) {
  const bool wasRunning = running_;
  running_ = true;
  stepIndex_ = 0;
  if (choice(P.sync) == ArpSyncKey) {
    gridBeat_ = stepBeat_ = keyBeat;
    return;
  }
  // Grid: the next step on the song's grid. A key just after a grid point
  // plays at once, unless that point's step already played (a tail running).
  if (wasRunning && stepBeat_ >= keyBeat) return;
  const double len = stepLen();
  const Beats g = std::ceil(keyBeat / len - 1e-9) * len;
  const Beats prev = g - len;
  if (!wasRunning && keyBeat - prev <= t_->seconds(kGraceSeconds)) {
    gridBeat_ = prev;
    stepBeat_ = keyBeat;
    return;
  }
  gridBeat_ = g;
  const long gi = std::lround(g / len);
  stepBeat_ = g + ((gi & 1) ? get(P.swing) / 100.0 * len / 3.0 : 0.0);
}

int Arp::activeNotes(int* notes, float* vels, int* chans, bool byOrder) const {
  int idx[kMaxNotes];
  int n = 0;
  for (int i = 0; i < nChord_; ++i)
    if (!chord_[static_cast<std::size_t>(i)].gone) idx[n++] = i;
  std::sort(idx, idx + n, [&](int a, int b) {
    const Entry& x = chord_[static_cast<std::size_t>(a)];
    const Entry& y = chord_[static_cast<std::size_t>(b)];
    return byOrder ? x.order < y.order : x.note < y.note;
  });
  for (int i = 0; i < n; ++i) {
    const Entry& c = chord_[static_cast<std::size_t>(idx[i])];
    notes[i] = c.note;
    vels[i] = c.vel;
    chans[i] = c.channel;
  }
  return n;
}

void Arp::step(int sample) {
  const double len = stepLen();
  const Beats at = stepBeat_;
  const int mode = std::clamp(choice(P.mode), 0, static_cast<int>(ArpPatternMode));
  const int oct = std::clamp(choice(P.octaves), 1, 4);

  int base[kMaxNotes], chan[kMaxNotes];
  float bvel[kMaxNotes];
  const int nb = activeNotes(base, bvel, chan, mode == ArpAsPlayed);

  if (nb > 0) {
    const bool fixed = choice(P.velMode) == 1;
    const float fv = std::clamp(get(P.velFixed), 1.f, 127.f) / 127.f;
    const double gate = get(P.gate) / 100.0;
    const Beats minLen = t_->seconds(0.003);
    auto playFor = [&](int note, float vel, int ch, Beats dur) {
      if (note < 0 || note > 127) return;
      MidiEvent e = NoteOn{note, std::clamp(vel, 1.f / 127.f, 1.f), ch};
      e.arp = true;
      emit(e, sample);
      if (nOffs_ >= kMaxOffs) flushOffs(sample, true);  // never lose a note-off
      offs_[static_cast<std::size_t>(nOffs_++)] = Off{at + std::max(dur, minLen), note, ch};
    };
    auto play = [&](int note, float vel, int ch) { playFor(note, fixed ? fv : vel, ch, len * gate); };
    const long k = stepIndex_;
    if (mode == ArpPatternMode) {
      // The drawn pattern: each note's row picks a chord tone.
      const ArpPattern* pat = nullptr;
      if (bank_) pat = &bank_->read().patterns[static_cast<std::size_t>(std::clamp(static_cast<int>(std::lround(get(P.pattern))) - 1, 0, kArpPatterns - 1))];
      const int steps = pat ? std::clamp(pat->steps, 1, kArpMaxSteps) : 1;
      const int p = static_cast<int>(k % steps);
      if (pat)
        for (int i = 0; i < std::min(pat->count, kArpMaxPatternNotes); ++i) {
          const ArpPatternNote& n = pat->notes[static_cast<std::size_t>(i)];
          if (n.step != p) continue;
          if (n.chance < 100 && rng_.uniform() * 100.f >= static_cast<float>(n.chance)) continue;
          const int r = n.row;
          const int idx = ((r % nb) + nb) % nb;
          const int octave = (r - idx) / nb;
          const float v = n.vel / 127.f * (fixed ? fv : bvel[idx]);
          playFor(base[idx] + 12 * octave, v, chan[idx], (std::max<int>(n.len, 1) - 1 + gate) * len);
        }
      stepPos_ = static_cast<float>(p) / static_cast<float>(steps);
    } else if (mode == ArpChord) {
      const int o = static_cast<int>(k % oct);
      for (int i = 0; i < nb; ++i) play(base[i] + 12 * o, bvel[i], chan[i]);
      stepPos_ = oct > 1 ? static_cast<float>(o) / static_cast<float>(oct) : 0.f;
    } else {
      // The notes across the octaves, low to high (or in playing order).
      const int n = nb * oct;
      auto at_ = [&](int i) { return i % nb; };
      auto noteAt = [&](int i) { return base[at_(i)] + 12 * (i / nb); };
      int i = 0, cycle = n;
      switch (mode) {
        case ArpUp: case ArpAsPlayed: i = static_cast<int>(k % n); break;
        case ArpDown: i = n - 1 - static_cast<int>(k % n); break;
        case ArpUpDown: case ArpDownUp: {
          cycle = n < 2 ? 1 : 2 * n - 2;
          int p = static_cast<int>(k % cycle);
          i = p < n ? p : cycle - p;
          if (mode == ArpDownUp) i = n - 1 - i;
          if (n < 2) i = 0;
          break;
        }
        case ArpRandom: {
          i = rng_.integer(0, n - 1);
          if (n > 1 && i == lastRandom_) i = (i + 1 + rng_.integer(0, n - 2)) % n;
          lastRandom_ = i;
          break;
        }
        default: break;
      }
      play(noteAt(i), bvel[at_(i)], chan[at_(i)]);
      stepPos_ = mode == ArpRandom ? static_cast<float>(i) / static_cast<float>(n)
                                   : static_cast<float>(k % cycle) / static_cast<float>(cycle);
    }
  }

  if (nStepMarks_ < kMaxStepMarks) stepMarks_[static_cast<std::size_t>(nStepMarks_++)] = {sample, stepPos_};
  ++stepIndex_;
  const double swing = get(P.swing) / 100.0 * len / 3.0;
  if (choice(P.sync) == ArpSyncKey) {
    gridBeat_ += len;
    stepBeat_ = gridBeat_ + ((stepIndex_ & 1) ? swing : 0.0);
  } else {
    // Stay on the song's grid, even if the rate changed.
    gridBeat_ = (std::floor(gridBeat_ / len + 1e-6) + 1.0) * len;
    const long gi = std::lround(gridBeat_ / len);
    stepBeat_ = gridBeat_ + ((gi & 1) ? swing : 0.0);
  }
  if (stepBeat_ <= at) stepBeat_ = at + len;  // always move forward
}

}  // namespace sk::detail
