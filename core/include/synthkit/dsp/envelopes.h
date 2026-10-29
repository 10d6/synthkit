#pragma once

#include <cmath>

#include "synthkit/dsp/util.h"

namespace sk::dsp {

// ADSR. Attack is a linear ramp (from the current level, so retriggers don't
// click); decay and release are exponential, i.e. straight lines in dB,
// reaching -80 dB of the distance at the set time.
class Adsr {
 public:
  enum class Stage { Idle, Attack, Decay, Sustain, Release };

  void prepare(float sampleRate) { sr_ = sampleRate; recompute(); }
  void set(float attack, float decay, float sustain, float release) {
    a_ = std::max(attack, 0.f);
    d_ = std::max(decay, 0.f);
    s_ = clamp(sustain, 0.f, 1.f);
    r_ = std::max(release, 0.f);
    recompute();
  }

  void gate(bool on) {
    if (on) stage_ = Stage::Attack;
    else if (stage_ != Stage::Idle) stage_ = Stage::Release;
  }
  void reset() { stage_ = Stage::Idle; level_ = 0; }
  Stage stage() const { return stage_; }
  bool idle() const { return stage_ == Stage::Idle; }
  float level() const { return level_; }

  float next() {
    switch (stage_) {
      case Stage::Idle: break;
      case Stage::Attack:
        level_ += attackRate_;
        if (level_ >= 1.f) { level_ = 1.f; stage_ = Stage::Decay; }
        break;
      case Stage::Decay:
      case Stage::Sustain:
        // Sustain keeps following the sustain level smoothly if it changes.
        level_ = s_ + (level_ - s_) * decayCoef_;
        if (stage_ == Stage::Decay && std::fabs(level_ - s_) < 1e-4f) stage_ = Stage::Sustain;
        break;
      case Stage::Release:
        level_ *= releaseCoef_;
        if (level_ < 1e-4f) { level_ = 0; stage_ = Stage::Idle; }
        break;
    }
    return level_;
  }

 private:
  static constexpr float kLn1e4 = -9.21034037f;  // ln(1e-4) = -80 dB
  void recompute() {
    attackRate_ = a_ <= 0 ? 1.f : 1.f / (a_ * sr_);
    decayCoef_ = d_ <= 0 ? 0.f : std::exp(kLn1e4 / (d_ * sr_));
    releaseCoef_ = r_ <= 0 ? 0.f : std::exp(kLn1e4 / (r_ * sr_));
  }
  float sr_ = 48000, a_ = 0.01f, d_ = 0.1f, s_ = 1, r_ = 0.1f;
  float attackRate_ = 0, decayCoef_ = 0, releaseCoef_ = 0, level_ = 0;
  Stage stage_ = Stage::Idle;
};

// Low-frequency oscillator. Free-running in Hz, or locked to a beat position
// (pass the musical position each control block via syncTo).
class Lfo {
 public:
  enum class Shape { Sine, Triangle, Saw, Square, SampleHold };

  void prepare(float sampleRate) { sr_ = sampleRate; }
  void setShape(Shape s) { shape_ = s; }
  void setRate(float hz) { rate_ = hz; }
  void reset(float phase = 0) { phase_ = phase - std::floor(phase); last_ = -1; }
  // Set phase from a position in beats and a period in beats.
  void syncTo(double beat, double periodBeats, float phaseOffset = 0) {
    if (periodBeats <= 0) return;
    double p = beat / periodBeats + phaseOffset;
    phase_ = static_cast<float>(p - std::floor(p));
  }
  void advance(int samples) {
    phase_ += rate_ * static_cast<float>(samples) / sr_;
    phase_ -= std::floor(phase_);
  }
  float phase() const { return phase_; }

  // Bipolar value -1…1 at the current phase. S&H draws a new value each cycle
  // from the supplied rng-like callable (float()).
  template <typename R>
  float value(R& rng) {
    if (shape_ == Shape::SampleHold) {
      if (phase_ < last_ || last_ < 0) held_ = rng.bipolar();
      last_ = phase_;
      return held_;
    }
    last_ = phase_;
    return shapeAt(phase_);
  }
  float value() {
    struct NoRng { float bipolar() { return 0; } } n;
    return value(n);
  }

  float shapeAt(float p) const {
    switch (shape_) {
      case Shape::Sine: return std::sin(kTwoPi * p);
      case Shape::Triangle: return p < 0.5f ? 4.f * p - 1.f : 3.f - 4.f * p;
      case Shape::Saw: return 1.f - 2.f * p;
      case Shape::Square: return p < 0.5f ? 1.f : -1.f;
      case Shape::SampleHold: return held_;
    }
    return 0;
  }

 private:
  float sr_ = 48000, rate_ = 1, phase_ = 0, held_ = 0, last_ = -1;
  Shape shape_ = Shape::Sine;
};

}  // namespace sk::dsp
