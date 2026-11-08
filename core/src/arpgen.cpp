// The arpeggiator's pattern generator and Evolve (API.md §4b). Random, but
// shaped the way a played line is: rhythm that leans on the strong steps,
// mostly stepwise movement over chord tones with leaps that turn back, short
// motifs that repeat and vary in a form (AABA, ABAC…), and accents that
// follow the beat. Allocation-free, so Evolve can use it on the audio thread.
#include <algorithm>
#include <cmath>

#include "arp.h"

namespace sk::detail {

namespace {

// How strong a step is within a 16-step bar: the downbeat, then half bar,
// beats, eighths, and the sixteenths in between.
float metricWeight(int step) {
  const int s = step % 16;
  if (s == 0) return 1.f;
  if (s % 8 == 0) return 0.85f;
  if (s % 4 == 0) return 0.7f;
  if (s % 2 == 0) return 0.45f;
  return 0.25f;
}

struct CellNote { int off = 0, row = 0, len = 1, vel = 100; };
struct Cell { std::array<CellNote, 32> n{}; int count = 0; };

int clampRow(int r) { return std::clamp(r, kArpRowLow, kArpRowHigh); }

void makeCell(const ArpGenSettings& g, dsp::Rng& r, int cellLen, int cellStart, bool anchor, Cell& c) {
  c.count = 0;
  const int hi = std::max(1, g.range) - 1;
  // Rhythm: onsets where the beat is strong; density moves every step's
  // chance together, so sparse keeps the downbeats and busy fills the gaps.
  std::array<bool, kArpMaxSteps> on{};
  int onsets = 0;
  for (int o = 0; o < cellLen; ++o) {
    const float w = metricWeight(cellStart + o);
    float p = std::clamp(0.9f * w + 0.1f + (g.density - 0.5f) * 1.4f, 0.f, 1.f);
    if (o == 0) p = std::max(p, anchor ? 1.f : 0.8f);
    on[static_cast<std::size_t>(o)] = r.chance(p);
    onsets += on[static_cast<std::size_t>(o)];
  }
  // Pitch: a contour (rising, falling, arch or valley) walked over chord
  // tones, mostly by step; leaps turn back. A new motif starts at a
  // contrasting height; the first starts on the lowest chord tone.
  int row = anchor ? 0 : (r.integer(0, hi) + r.integer(0, hi) + 1) / 2;
  const int contour = r.integer(0, 3);   // 0 up, 1 down, 2 arch, 3 valley
  if (!anchor && contour == 1 && row < hi / 2) row = std::min(hi, row + hi / 2);   // room to fall
  int lastMove = 0, repeats = 0, idx = 0;
  bool first = true;
  for (int o = 0; o < cellLen; ++o) {
    if (!on[static_cast<std::size_t>(o)]) continue;
    if (!first) {
      const bool firstHalf = idx * 2 < onsets;
      int want = contour == 0 ? 1 : contour == 1 ? -1 : contour == 2 ? (firstHalf ? 1 : -1) : (firstHalf ? -1 : 1);
      if (r.chance(0.2f)) want = -want;
      int move;
      if (std::abs(lastMove) >= 2) move = lastMove > 0 ? -1 : 1;              // fill the gap a leap left
      else if (r.chance(g.leaps * 0.65f)) move = want * r.integer(2, std::max(2, hi / 2 + 1));
      else if (repeats < 1 && r.chance(0.08f + 0.2f * (1.f - g.density))) move = 0;
      else move = want;
      int next = row + move;
      if (next > hi) next = row - std::max(1, std::abs(move));                // turn at the edges
      if (next < 0) next = row + std::max(1, std::abs(move));
      next = std::clamp(next, 0, hi);
      repeats = next == row ? repeats + 1 : 0;
      lastMove = next - row;
      row = next;
    }
    ++idx;
    first = false;
    // Length: tie into following rests, sometimes.
    int gap = 1;
    while (o + gap < cellLen && !on[static_cast<std::size_t>(o + gap)]) ++gap;
    const int len = gap > 1 && r.chance(g.ties) ? r.integer(2, gap) : 1;
    const float w = metricWeight(cellStart + o);
    const int vel = std::clamp(static_cast<int>(std::lround(62 + 54 * w)) + r.integer(-6, 6), 1, 127);
    if (c.count < static_cast<int>(c.n.size())) c.n[static_cast<std::size_t>(c.count++)] = CellNote{o, row, len, vel};
    // Double stops on strong steps: a second chord tone two rows up.
    if (w >= 0.7f && r.chance(g.chords) && c.count < static_cast<int>(c.n.size()))
      c.n[static_cast<std::size_t>(c.count++)] = CellNote{o, row + 2, len, std::max(1, vel - 14)};
  }
}

// A repeat of a cell, changed a little: shifted by a chord tone, a new last
// note, or a weak note added or dropped.
void varyCell(const ArpGenSettings& g, dsp::Rng& r, int cellLen, int cellStart, Cell& c) {
  const int hi = std::max(1, g.range) - 1;
  if (c.count == 0) return;
  switch (r.integer(0, 2)) {
    case 0: {
      const int d = r.chance(0.5f) ? 1 : -1;
      for (int i = 0; i < c.count; ++i) c.n[static_cast<std::size_t>(i)].row = std::clamp(c.n[static_cast<std::size_t>(i)].row + d, 0, hi + 2);
      break;
    }
    case 1: {
      CellNote& last = c.n[static_cast<std::size_t>(c.count - 1)];
      last.row = std::clamp(last.row + (r.chance(0.5f) ? 1 : -1) * r.integer(1, 2), 0, hi);
      break;
    }
    default: {
      // Toggle an offbeat.
      const int o = std::min(cellLen - 1, 2 * r.integer(0, std::max(0, cellLen / 2 - 1)) + 1);
      int at = -1;
      for (int i = 0; i < c.count; ++i) if (c.n[static_cast<std::size_t>(i)].off == o) at = i;
      if (at >= 0) {
        for (int i = at; i < c.count - 1; ++i) c.n[static_cast<std::size_t>(i)] = c.n[static_cast<std::size_t>(i + 1)];
        --c.count;
      } else if (c.count < static_cast<int>(c.n.size())) {
        // Insert in order, a neighbour of the note before it.
        int prevRow = 0, pos = 0;
        while (pos < c.count && c.n[static_cast<std::size_t>(pos)].off < o) prevRow = c.n[static_cast<std::size_t>(pos++)].row;
        for (int i = c.count; i > pos; --i) c.n[static_cast<std::size_t>(i)] = c.n[static_cast<std::size_t>(i - 1)];
        const float w = metricWeight(cellStart + o);
        c.n[static_cast<std::size_t>(pos)] = CellNote{o, std::clamp(prevRow + (r.chance(0.5f) ? 1 : -1), 0, hi), 1,
                                                      std::clamp(static_cast<int>(std::lround(62 + 54 * w)), 1, 127)};
        ++c.count;
      }
      break;
    }
  }
}

}  // namespace

void arpGenerate(const ArpGenSettings& gIn, ArpPattern& out) {
  ArpGenSettings g = gIn;
  g.steps = std::clamp(g.steps, 1, kArpMaxSteps);
  g.range = std::clamp(g.range, 2, 16);
  g.density = std::clamp(g.density, 0.f, 1.f);
  g.leaps = std::clamp(g.leaps, 0.f, 1.f);
  g.repetition = std::clamp(g.repetition, 0.f, 1.f);
  g.ties = std::clamp(g.ties, 0.f, 1.f);
  g.chords = std::clamp(g.chords, 0.f, 1.f);
  dsp::Rng r(dsp::hashSeed(g.seed, 0x6E4u, static_cast<uint64_t>(g.steps)));

  const int cellLen = g.steps >= 32 ? 8 : g.steps >= 8 ? 4 : g.steps;
  const int nCells = (g.steps + cellLen - 1) / cellLen;

  // The form: how the cells repeat. More repetition, fewer new ideas.
  static const char* kForms[3][3] = {{"ABCD", "ABCB", "ABAC"}, {"ABAB", "AABB", "ABAC"}, {"AABA", "AAAB", "AABA"}};
  const int tier = g.repetition >= 0.7f ? 2 : g.repetition >= 0.35f ? 1 : 0;
  const char* form = kForms[tier][r.integer(0, 2)];

  std::array<Cell, 4> cells{};
  std::array<bool, 4> made{};
  out.steps = g.steps;
  out.count = 0;
  for (int ci = 0; ci < nCells; ++ci) {
    const int start = ci * cellLen;
    const int len = std::min(cellLen, g.steps - start);
    const int letter = form[ci % 4] - 'A';
    Cell c;
    if (!made[static_cast<std::size_t>(letter)]) {
      makeCell(g, r, cellLen, start, ci == 0, cells[static_cast<std::size_t>(letter)]);
      made[static_cast<std::size_t>(letter)] = true;
      c = cells[static_cast<std::size_t>(letter)];
    } else {
      c = cells[static_cast<std::size_t>(letter)];
      // Repeats vary more with less repetition, and the second half of a
      // long pattern a little more than the first.
      const float vary = (1.f - g.repetition) * 0.85f + (ci >= 4 ? 0.2f : 0.f);
      if (r.chance(vary)) varyCell(g, r, cellLen, start, c);
    }
    // The last cell leads back to the start: its last note a chord tone away.
    if (ci == nCells - 1 && nCells > 1 && c.count > 0 && r.chance(0.4f + 0.5f * g.repetition)) {
      CellNote& last = c.n[static_cast<std::size_t>(c.count - 1)];
      if (last.row > 2) last.row = 1;
    }
    for (int i = 0; i < c.count && out.count < kArpMaxPatternNotes; ++i) {
      const CellNote& n = c.n[static_cast<std::size_t>(i)];
      if (n.off >= len) continue;
      const int step = start + n.off;
      ArpPatternNote pn;
      pn.step = static_cast<int16_t>(step);
      pn.row = static_cast<int16_t>(clampRow(n.row));
      pn.len = static_cast<int16_t>(std::clamp(n.len, 1, g.steps - step));
      pn.vel = static_cast<uint8_t>(std::clamp(n.vel, 1, 127));
      pn.chance = 100;
      out.notes[static_cast<std::size_t>(out.count++)] = pn;
    }
  }
}

// ---------------------------------------------------------------- Evolve

namespace {
bool sameNote(const ArpPatternNote& a, const ArpPatternNote& b) {
  return a.step == b.step && a.row == b.row && a.len == b.len && a.vel == b.vel && a.chance == b.chance;
}
}  // namespace

void arpEvolve(const ArpPattern& original, ArpPattern& work, float amount, dsp::Rng& r) {
  if (work.count != original.count || work.steps != original.steps) work = original;
  if (original.count == 0 || amount <= 0) return;
  auto mutate = [&] {
    ArpPatternNote& n = work.notes[static_cast<std::size_t>(r.integer(0, work.count - 1))];
    const float k = r.uniform();
    if (k < 0.5f) {
      n.row = static_cast<int16_t>(clampRow(n.row + (r.chance(0.5f) ? 1 : -1) * (r.chance(0.8f) ? 1 : 2)));
    } else if (k < 0.7f) {
      const int s = n.step + (r.chance(0.5f) ? 1 : -1);
      if (s >= 0 && s + n.len <= work.steps) n.step = static_cast<int16_t>(s);
    } else if (k < 0.85f) {
      n.chance = n.chance == 0 ? 100 : 0;   // drop the note for now (or bring it back)
    } else {
      n.vel = static_cast<uint8_t>(std::clamp(n.vel + (r.chance(0.5f) ? 1 : -1) * r.integer(10, 25), 1, 127));
    }
  };
  if (r.chance(amount)) mutate();
  if (r.chance(amount * amount)) mutate();
  // Stay recognisable: at most about half the notes (at full Evolve) differ.
  const int limit = std::max(1, static_cast<int>(std::lround(amount * original.count * 0.5f)));
  for (;;) {
    int diff = 0;
    for (int i = 0; i < work.count; ++i) diff += !sameNote(work.notes[static_cast<std::size_t>(i)], original.notes[static_cast<std::size_t>(i)]);
    if (diff <= limit) break;
    int pick = r.integer(1, diff);
    for (int i = 0; i < work.count; ++i)
      if (!sameNote(work.notes[static_cast<std::size_t>(i)], original.notes[static_cast<std::size_t>(i)]) && --pick == 0) {
        work.notes[static_cast<std::size_t>(i)] = original.notes[static_cast<std::size_t>(i)];
        break;
      }
  }
}

}  // namespace sk::detail
