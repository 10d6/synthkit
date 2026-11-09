#include "seq.h"

#include <algorithm>
#include <cmath>

namespace sk::detail {

namespace {
constexpr double kGraceSeconds = 0.04;   // as the arpeggiator: a key this late for a grid step plays at once
}

void Seq::prepare(double sampleRate, int maxBlock) {
  sr_ = sampleRate;
  maxBlock_ = std::max(maxBlock, 1);
  phraseBuf_.assign(static_cast<std::size_t>(kLanes) * static_cast<std::size_t>(maxBlock_), 0.f);
  for (auto& l : lanes_) l.env.prepare(static_cast<float>(sr_));
  reset();
}

void Seq::reset() {
  for (auto& l : lanes_) { l.used = l.gate = false; l.env.reset(); l.evolvedFrom = -1; }
  nOffs_ = 0;
  down_.fill(0);
  sustained_.fill(false);
  pedal_ = allOff_ = false;
  latest_ = -1;
  stepPos_ = 0;
}

float Seq::stepPosAt(int sample) const {
  float v = stepPosStart_;
  for (int i = 0; i < nStepMarks_ && stepMarks_[static_cast<std::size_t>(i)].first <= sample; ++i) v = stepMarks_[static_cast<std::size_t>(i)].second;
  return v;
}

int Seq::sampleOf(Beats b) const {
  const double pos = std::floor((b - blockStart_) * spb_ + 1e-6);
  return pos < 0 ? 0 : pos >= frames_ ? frames_ : static_cast<int>(pos);
}

int Seq::heldKeys() const {
  int n = 0;
  for (int i = 0; i < 128; ++i) n += down_[static_cast<std::size_t>(i)] > 0 || sustained_[static_cast<std::size_t>(i)];
  return n;
}

void Seq::emit(MidiEvent e, int sample) {
  e.sample = std::clamp(sample, 0, frames_ - 1);
  e.beat = blockStart_ + e.sample / spb_;
  if (*outCount_ >= outCap_) { ++*dropped_; return; }
  out_[(*outCount_)++] = e;
}

void Seq::flushOffs(int sample, bool all, int lane) {
  int k = 0;
  for (int i = 0; i < nOffs_; ++i) {
    const Off& o = offs_[static_cast<std::size_t>(i)];
    const int s = sampleOf(o.beat);
    const bool mine = lane < 0 || o.lane == lane;
    if (mine && (all || s <= sample)) {
      MidiEvent e = NoteOff{o.note, o.channel};
      e.arp = true;
      e.arpLane = static_cast<int8_t>(o.lane);
      emit(e, all ? sample : s);
    } else {
      offs_[static_cast<std::size_t>(k++)] = o;
    }
  }
  nOffs_ = k;
}

void Seq::advanceEnvs(int to) {
  if (to <= envPos_) return;
  for (int li = 0; li < kLanes; ++li) {
    Lane& l = lanes_[static_cast<std::size_t>(li)];
    float* buf = phraseBuf_.data() + static_cast<std::size_t>(li) * static_cast<std::size_t>(maxBlock_);
    if (l.env.idle() && !l.gate) { std::fill(buf + envPos_, buf + to, 0.f); continue; }
    for (int i = envPos_; i < to; ++i) buf[i] = l.env.next();
  }
  envPos_ = to;
}

void Seq::clearAll(bool hard) {
  flushOffs(envPos_, true);
  for (auto& l : lanes_) {
    l.used = l.gate = false;
    l.env.gate(false);
    if (hard) l.env.reset();
  }
  down_.fill(0);
  sustained_.fill(false);
}

void Seq::process(const ArpParams& P, const MidiEvent* in, int nIn, MidiEvent* out, int& outCount, int outCap, int& dropped,
                  const float* vals, Beats blockStart, double spb, int frames, const Transport& t, bool jumped) {
  P_ = &P;
  vals_ = vals;
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
  for (auto& l : lanes_) l.env.set(get(P.pa), get(P.pd), get(P.ps), get(P.pr));

  if (allOff_) { allOff_ = false; clearAll(false); }
  const bool on = choice(P.on) == ArpTypeSeq;
  if (!on) {
    if (wasOn_) {
      // Turned off: sequences stop and fade with their envelopes; the keys
      // were already sounding as ordinary notes.
      flushOffs(0, true);
      for (auto& l : lanes_) { l.used = l.gate = false; l.env.gate(false); }
      down_.fill(0);
      sustained_.fill(false);
      wasOn_ = false;
    }
    for (int i = 0; i < nIn; ++i) {
      if (outCount >= outCap) { ++dropped; continue; }
      out[outCount++] = in[i];
    }
    advanceEnvs(frames);
    return;
  }
  wasOn_ = true;

  if (jumped) {
    flushOffs(0, true);
    const double len = stepLen();
    for (auto& l : lanes_) {
      if (!l.used) continue;
      if (choice(P.seqSync) == ArpSyncGrid) {
        l.gridBeat = l.stepBeat = std::ceil((blockStart - 1e-9) / len) * len;
        l.step = std::lround(l.gridBeat / len);
      } else {
        l.gridBeat = l.stepBeat = blockStart;
      }
    }
  }

  int ei = 0;
  for (;;) {
    const int nextEv = ei < nIn ? std::clamp(in[ei].sample, 0, frames - 1) : frames;
    int nextOff = frames;
    for (int i = 0; i < nOffs_; ++i) nextOff = std::min(nextOff, sampleOf(offs_[static_cast<std::size_t>(i)].beat));
    int nextStep = frames, lane = -1;
    for (int li = 0; li < kLanes; ++li) {
      const Lane& l = lanes_[static_cast<std::size_t>(li)];
      if (!l.used) continue;
      const int s = sampleOf(l.stepBeat);
      if (s < nextStep || (s == nextStep && lane >= 0 && l.serial < lanes_[static_cast<std::size_t>(lane)].serial)) { nextStep = s; lane = li; }
    }
    const int at = std::min({nextEv, nextOff, nextStep});
    if (at >= frames) break;
    advanceEnvs(at);
    // Same sample: note-offs, then keys, then steps; except that with
    // Crossfade a step goes before the note-offs, so a repeated pitch can
    // carry on instead of ending (its note-off moves later).
    const bool stepFirst = nextStep == at && choice(P.envMode) == ArpEnvCrossfade;
    if (nextOff == at && !stepFirst) { flushOffs(at, false); continue; }
    if (nextEv == at) { handle(in[ei++]); continue; }
    if (nextStep != at) { flushOffs(at, false); continue; }
    Lane& l = lanes_[static_cast<std::size_t>(lane)];
    if (!l.gate && l.env.idle()) { l.used = false; continue; }   // its release has finished
    step(lane, at);
  }
  advanceEnvs(frames);
  for (auto& l : lanes_)
    if (l.used && !l.gate && l.env.idle()) l.used = false;
}

void Seq::handle(const MidiEvent& e) {
  if (e.isNoteOn() && !e.arp) {
    emit(e, e.sample);   // the key itself plays as usual
    const int n = std::clamp(e.note, 0, 127);
    const bool latch = get(P_->latch) >= 0.5f;
    if (latch && heldKeys() == 0)   // a new phrase lets go of the latched sequences
      for (auto& l : lanes_) if (l.gate) { l.gate = false; l.env.gate(false); }
    // The key's lane: its own if it's still playing (a retrigger), else a
    // free one, else the oldest released, else the oldest.
    int li = -1;
    for (int i = 0; i < kLanes; ++i) if (lanes_[static_cast<std::size_t>(i)].used && lanes_[static_cast<std::size_t>(i)].key == n) li = i;
    if (li < 0) for (int i = 0; i < kLanes && li < 0; ++i) if (!lanes_[static_cast<std::size_t>(i)].used && lanes_[static_cast<std::size_t>(i)].env.idle()) li = i;
    if (li < 0) for (int i = 0; i < kLanes && li < 0; ++i) if (!lanes_[static_cast<std::size_t>(i)].used) li = i;
    auto oldest = [&](bool released) {
      int best = -1;
      for (int i = 0; i < kLanes; ++i) {
        const Lane& l = lanes_[static_cast<std::size_t>(i)];
        if (released && l.gate) continue;
        if (best < 0 || l.serial < lanes_[static_cast<std::size_t>(best)].serial) best = i;
      }
      return best;
    };
    if (li < 0) li = oldest(true);
    if (li < 0) li = oldest(false);
    const bool retrigger = lanes_[static_cast<std::size_t>(li)].used && lanes_[static_cast<std::size_t>(li)].key == n;
    if (!retrigger) {
      flushOffs(e.sample, true, li);   // a stolen lane's notes end
      lanes_[static_cast<std::size_t>(li)].env.reset();
    }
    startLane(li, e, blockStart_ + std::clamp(e.sample, 0, frames_ - 1) / spb_);
    if (down_[static_cast<std::size_t>(n)] < 255) ++down_[static_cast<std::size_t>(n)];
    sustained_[static_cast<std::size_t>(n)] = false;
    return;
  }
  if (e.isNoteOff() && !e.arp) {
    emit(e, e.sample);
    const int n = std::clamp(e.note, 0, 127);
    if (down_[static_cast<std::size_t>(n)] == 0) return;
    if (--down_[static_cast<std::size_t>(n)] == 0) {
      if (pedal_) sustained_[static_cast<std::size_t>(n)] = true;
      else releaseKey(n);
    }
    return;
  }
  if (e.isCC(64)) {
    const bool p = e.value >= 0.5f;
    if (pedal_ && !p) {
      pedal_ = false;
      for (int n = 0; n < 128; ++n)
        if (sustained_[static_cast<std::size_t>(n)]) { sustained_[static_cast<std::size_t>(n)] = false; releaseKey(n); }
    }
    pedal_ = p;
  } else if (e.isCC(123) || e.isCC(120)) {
    clearAll(e.isCC(120));
  }
  emit(e, e.sample);
}

void Seq::releaseKey(int note) {
  if (get(P_->latch) >= 0.5f) return;
  for (auto& l : lanes_)
    if (l.used && l.gate && l.key == note) { l.gate = false; l.env.gate(false); }
}

void Seq::startLane(int li, const MidiEvent& e, Beats keyBeat) {
  Lane& l = lanes_[static_cast<std::size_t>(li)];
  l.used = true;
  l.gate = true;
  l.key = std::clamp(e.note, 0, 127);
  l.channel = e.channel;
  l.vel = e.vel;
  l.serial = ++serial_;
  l.rng.seed(dsp::hashSeed(serial_, 0x5E9u, static_cast<uint64_t>(l.key)));
  l.evolvedFrom = -1;
  l.env.gate(true);
  latest_ = li;
  const double len = stepLen();
  if (choice(P_->seqSync) == ArpSyncKey) {
    l.step = 0;
    l.gridBeat = l.stepBeat = keyBeat;
    if (get(P_->quantize) >= 0.5f) {
      // Quantize: the sequence locks to the nearest increment. Early, it
      // waits for it; late, step 1 plays at once and the steps after it
      // fall on the timeline counted from the increment (step() catches up).
      const double q = arpRateBeats(choice(P_->quantizeTo));
      const Beats anchor = std::round(keyBeat / q) * q;
      l.gridBeat = anchor;
      l.stepBeat = std::max(anchor, keyBeat);
    }
    return;
  }
  // Grid: join the song's grid where it is, so every key's sequence lines
  // up; a key just late for a grid step plays at once.
  const Beats g = std::ceil(keyBeat / len - 1e-9) * len;
  const Beats prev = g - len;
  if (keyBeat - prev <= t_->seconds(kGraceSeconds)) {
    l.gridBeat = prev;
    l.stepBeat = keyBeat;
  } else {
    l.gridBeat = g;
    const long gi = std::lround(g / len);
    l.stepBeat = g + ((gi & 1) ? get(P_->swing) / 100.0 * len / 3.0 : 0.0);
  }
  l.step = std::lround(l.gridBeat / len);
}

void Seq::step(int li, int sample) {
  Lane& l = lanes_[static_cast<std::size_t>(li)];
  const ArpParams& P = *P_;
  const double len = stepLen();
  const Beats at = l.stepBeat;

  const int pi = std::clamp(choice(P.pattern) - 1, 0, kArpPatterns - 1);
  const ArpPattern* pat = bank_ ? &bank_->read().patterns[static_cast<std::size_t>(pi)] : nullptr;
  const int steps = pat ? std::clamp(pat->steps, 1, kArpMaxSteps) : 1;
  const int p = static_cast<int>(((l.step % steps) + steps) % steps);
  const float evolve = std::clamp(get(P.evolve) / 100.f, 0.f, 1.f);
  if (pat && evolve > 0) {
    if (l.evolvedFrom != pi || l.evolvedGen != bank_->generation()) {
      l.evolved = *pat;
      l.evolvedFrom = pi;
      l.evolvedGen = bank_->generation();
    } else if (p == 0 && l.step > 0) {
      arpEvolve(*pat, l.evolved, evolve, l.rng);
    }
    pat = &l.evolved;
  }

  if (pat) {
    const bool xf = choice(P.envMode) == ArpEnvCrossfade;
    const double gate = get(P.gate) / 100.0;
    const bool fixed = choice(P.velMode) == 1;
    const float fv = std::clamp(get(P.velFixed), 1.f, 127.f) / 127.f;
    const int scale = choice(P.scale), root = choice(P.scaleKey);
    const Beats minLen = t_->seconds(0.003);
    for (int i = 0; i < std::min(pat->count, kArpMaxPatternNotes); ++i) {
      const ArpPatternNote& n = pat->notes[static_cast<std::size_t>(i)];
      if (n.step != p) continue;
      if (n.chance < 100 && l.rng.uniform() * 100.f >= static_cast<float>(n.chance)) continue;
      const int pitch = arpScalePitch(l.key, n.row, scale, root);
      if (pitch < 0 || pitch > 127) continue;
      const Beats dur = std::max((std::max<int>(n.len, 1) - 1 + (xf ? 1.0 : gate)) * len, minLen);
      if (xf) {
        // The same pitch again: carry on rather than fade into itself.
        bool joined = false;
        for (int k = 0; k < nOffs_ && !joined; ++k) {
          Off& o = offs_[static_cast<std::size_t>(k)];
          if (o.lane == li && o.note == pitch && std::fabs(o.beat - at) < 1e-6) { o.beat = at + dur; joined = true; }
        }
        if (joined) continue;
      }
      MidiEvent on = NoteOn{pitch, std::clamp(n.vel / 127.f * (fixed ? fv : l.vel), 1.f / 127.f, 1.f), l.channel};
      on.arp = true;
      on.arpLane = static_cast<int8_t>(li);
      emit(on, sample);
      if (nOffs_ >= kMaxOffs) flushOffs(sample, true);   // never lose a note-off
      offs_[static_cast<std::size_t>(nOffs_++)] = Off{at + dur, pitch, l.channel, li};
    }
    if (li == latest_) {
      stepPos_ = static_cast<float>(p) / static_cast<float>(steps);
      if (nStepMarks_ < kMaxStepMarks) stepMarks_[static_cast<std::size_t>(nStepMarks_++)] = {sample, stepPos_};
    }
  }

  ++l.step;
  const double swing = get(P.swing) / 100.0 * len / 3.0;
  if (choice(P.seqSync) == ArpSyncKey) {
    l.gridBeat += len;
    // A quantized lane that started late skips the slots already gone,
    // staying on its timeline.
    while (l.gridBeat <= at + 1e-9) { l.gridBeat += len; ++l.step; }
    l.stepBeat = l.gridBeat + ((l.step & 1) ? swing : 0.0);
  } else {
    l.gridBeat = (std::floor(l.gridBeat / len + 1e-6) + 1.0) * len;
    const long gi = std::lround(l.gridBeat / len);
    l.stepBeat = l.gridBeat + ((gi & 1) ? swing : 0.0);
  }
  if (l.stepBeat <= at) l.stepBeat = at + len;
}

}  // namespace sk::detail
