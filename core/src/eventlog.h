// The engine's diagnostics log (API.md §10a): the last kEventLogSize events an
// engine was given, and what it did about the ones that can't be right (a key
// pressed again while held, a note-off for no held note). Written by the audio
// thread (no allocation, no locks: three relaxed 32-bit atomics per entry),
// read by any thread for Engine::diagnostics(). An entry being overwritten
// while it's read is skipped, never torn: each carries its sequence number.
#pragma once

#include <synthkit/json.h>
#include <synthkit/midi.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>

namespace sk::detail {

enum class LogKind : uint8_t {
  NoteOn = 1,
  NoteOff,
  CC,
  PitchBend,
  ChannelPressure,
  PolyPressure,
  Repress,     // the engine: a held key pressed again (its release never arrived); the old voice let go
  Doubled,     // the engine: the same press arriving twice within 30 ms; ignored
  Unmatched,   // the engine: a note-off that found no held voice (stolen, already off, or never on)
  AllNotesOff,
  Panic,
};

inline const char* logKindName(LogKind k) {
  switch (k) {
    case LogKind::NoteOn: return "on";
    case LogKind::NoteOff: return "off";
    case LogKind::CC: return "cc";
    case LogKind::PitchBend: return "bend";
    case LogKind::ChannelPressure: return "pressure";
    case LogKind::PolyPressure: return "polyPressure";
    case LogKind::Repress: return "repress";
    case LogKind::Doubled: return "doubled";
    case LogKind::Unmatched: return "unmatchedOff";
    case LogKind::AllNotesOff: return "allNotesOff";
    case LogKind::Panic: return "panic";
  }
  return "?";
}

constexpr int kEventLogSize = 512;

class EventLog {
 public:
  // Audio thread. `time` in samples since prepare.
  void record(LogKind kind, int channel, int data1, float value, uint64_t time) {
    const uint32_t i = next_.load(std::memory_order_relaxed);
    Entry& e = ring_[i % kEventLogSize];
    e.seq.store(0, std::memory_order_relaxed);  // being written
    std::atomic_thread_fence(std::memory_order_release);
    e.time.store(static_cast<uint32_t>(time), std::memory_order_relaxed);
    e.packed.store(pack(kind, channel, data1, value), std::memory_order_relaxed);
    e.seq.store(i + 1, std::memory_order_release);
    next_.store(i + 1, std::memory_order_release);
  }
  void record(const MidiEvent& ev, uint64_t time) {
    using T = MidiEvent::Type;
    switch (ev.type) {
      case T::NoteOn: record(ev.vel > 0 ? LogKind::NoteOn : LogKind::NoteOff, ev.channel, ev.note, ev.vel, time); break;
      case T::NoteOff: record(LogKind::NoteOff, ev.channel, ev.note, ev.vel, time); break;
      case T::CC: record(LogKind::CC, ev.channel, ev.cc, ev.value, time); break;
      case T::PitchBend: record(LogKind::PitchBend, ev.channel, 0, ev.value, time); break;
      case T::ChannelPressure: record(LogKind::ChannelPressure, ev.channel, 0, ev.value, time); break;
      case T::PolyPressure: record(LogKind::PolyPressure, ev.channel, ev.note, ev.value, time); break;
    }
  }
  void clear() {
    for (auto& e : ring_) e.seq.store(0, std::memory_order_relaxed);
    next_.store(0, std::memory_order_release);
  }

  // Any thread: the entries still in the ring, oldest first, as
  // [{"t": seconds before `now`, "kind", "ch", "note"/"cc", "value"}, …].
  Json snapshot(uint64_t now, double sampleRate) const {
    Json out = Json::array();
    const uint32_t end = next_.load(std::memory_order_acquire);
    const uint32_t start = end > kEventLogSize ? end - kEventLogSize : 0;
    for (uint32_t i = start; i < end; ++i) {
      const Entry& e = ring_[i % kEventLogSize];
      const uint32_t s1 = e.seq.load(std::memory_order_acquire);
      const uint32_t time = e.time.load(std::memory_order_relaxed);
      const uint32_t packed = e.packed.load(std::memory_order_relaxed);
      std::atomic_thread_fence(std::memory_order_acquire);
      if (s1 != i + 1 || e.seq.load(std::memory_order_relaxed) != s1) continue;  // overwritten meanwhile
      const auto kind = static_cast<LogKind>(packed >> 28);
      const int ch = static_cast<int>((packed >> 24) & 15u);
      const int d1 = static_cast<int>((packed >> 16) & 255u);
      const float value = static_cast<float>(packed & 0xFFFFu) / 65535.f;
      const uint32_t age = static_cast<uint32_t>(now) - time;  // wraps cleanly (32 bits: 24 h at 48 kHz)
      Json j = Json::object();
      j["t"] = -std::round(static_cast<double>(age) / sampleRate * 10000.0) / 10000.0;
      j["kind"] = logKindName(kind);
      j["ch"] = ch + 1;  // as MIDI tools show channels, 1…16
      if (kind == LogKind::CC) j["cc"] = d1;
      else if (kind != LogKind::PitchBend && kind != LogKind::ChannelPressure && kind != LogKind::AllNotesOff &&
               kind != LogKind::Panic) j["note"] = d1;
      if (kind == LogKind::PitchBend) j["value"] = std::round((value * 2.0 - 1.0) * 1000.0) / 1000.0;
      else if (kind != LogKind::AllNotesOff && kind != LogKind::Panic) j["value"] = std::round(value * 1000.0) / 1000.0;
      out.push(j);
    }
    return out;
  }

  uint32_t total() const { return next_.load(std::memory_order_acquire); }

 private:
  struct Entry {
    std::atomic<uint32_t> seq{0}, time{0}, packed{0};
  };
  // kind(4) | channel(4) | note or cc(8) | value(16): bend -1…1 as 0…1, the rest 0…1.
  static uint32_t pack(LogKind kind, int channel, int data1, float value) {
    const float v = kind == LogKind::PitchBend ? (value + 1.f) * 0.5f : value;
    const uint32_t q = static_cast<uint32_t>(std::lround(std::clamp(v, 0.f, 1.f) * 65535.f));
    return (static_cast<uint32_t>(kind) << 28) | (static_cast<uint32_t>(channel & 15) << 24) |
           (static_cast<uint32_t>(std::clamp(data1, 0, 255)) << 16) | q;
  }
  std::array<Entry, kEventLogSize> ring_{};
  std::atomic<uint32_t> next_{0};
};

}  // namespace sk::detail
