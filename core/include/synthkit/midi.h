#pragma once

#include <cstdint>

namespace sk {

using Beats = double;  // musical time in quarter notes (like a host's PPQ)

// One MIDI-ish event inside a block. Velocity, CC and pressure values are
// normalised 0…1; pitch bend is -1…1.
struct MidiEvent {
  enum class Type : uint8_t { NoteOn, NoteOff, CC, PitchBend, ChannelPressure, PolyPressure };

  Type type = Type::NoteOn;
  uint8_t channel = 0;  // 0…15
  int note = 60;        // note events and poly pressure
  float vel = 0;        // note on/off velocity 0…1
  int cc = 0;           // controller number for CC events
  float value = 0;      // CC 0…1, bend -1…1, pressure 0…1
  int sample = -1;      // offset in the current block; -1 = block start
  Beats beat = 0;       // musical position (filled in by the kit)
  uint32_t tag = 0;     // set by EventContext::schedule, for cancel()

  bool isNoteOn() const { return type == Type::NoteOn && vel > 0; }
  bool isNoteOff() const { return type == Type::NoteOff || (type == Type::NoteOn && vel <= 0); }
  bool isCC(int n) const { return type == Type::CC && cc == n; }

  // Decode raw MIDI bytes. Returns false for messages synthkit ignores.
  static bool fromBytes(const uint8_t* data, int len, int sample, MidiEvent& out);
};

struct NoteOn {
  int note = 60;
  float vel = 0.8f;
  int channel = 0;
  operator MidiEvent() const {
    MidiEvent e;
    e.type = MidiEvent::Type::NoteOn;
    e.note = note; e.vel = vel; e.channel = static_cast<uint8_t>(channel & 15);
    return e;
  }
};

struct NoteOff {
  int note = 60;
  int channel = 0;
  float vel = 0.5f;
  operator MidiEvent() const {
    MidiEvent e;
    e.type = MidiEvent::Type::NoteOff;
    e.note = note; e.vel = vel; e.channel = static_cast<uint8_t>(channel & 15);
    return e;
  }
};

struct CC {
  int number = 1;
  float value = 0;
  int channel = 0;
  operator MidiEvent() const {
    MidiEvent e;
    e.type = MidiEvent::Type::CC;
    e.cc = number; e.value = value; e.channel = static_cast<uint8_t>(channel & 15);
    return e;
  }
};

inline bool MidiEvent::fromBytes(const uint8_t* d, int len, int sample, MidiEvent& e) {
  if (len < 1) return false;
  uint8_t status = d[0] & 0xF0;
  e = MidiEvent{};
  e.channel = d[0] & 0x0F;
  e.sample = sample;
  auto b = [&](int i) { return i < len ? (d[i] & 0x7F) : 0; };
  switch (status) {
    case 0x90: e.type = MidiEvent::Type::NoteOn; e.note = b(1); e.vel = b(2) / 127.f; return true;
    case 0x80: e.type = MidiEvent::Type::NoteOff; e.note = b(1); e.vel = b(2) / 127.f; return true;
    case 0xB0: e.type = MidiEvent::Type::CC; e.cc = b(1); e.value = b(2) / 127.f; return true;
    case 0xE0: {
      int v = (b(2) << 7) | b(1);
      e.type = MidiEvent::Type::PitchBend;
      e.value = v >= 8192 ? (v - 8192) / 8191.f : (v - 8192) / 8192.f;
      return true;
    }
    case 0xD0: e.type = MidiEvent::Type::ChannelPressure; e.value = b(1) / 127.f; return true;
    case 0xA0: e.type = MidiEvent::Type::PolyPressure; e.note = b(1); e.value = b(2) / 127.f; return true;
    default: return false;
  }
}

}  // namespace sk
