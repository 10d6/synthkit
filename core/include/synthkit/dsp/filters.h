#pragma once

#include <cmath>

#include "synthkit/dsp/util.h"

namespace sk::dsp {

// Zero-delay-feedback state-variable filter (Simper/Zavalishin). Stable under
// fast cutoff modulation. `res` 0…1; near 1 it rings but stays bounded.
class Svf {
 public:
  enum class Mode { LowPass, HighPass, BandPass, Notch };

  void prepare(float sampleRate) { sr_ = sampleRate; reset(); }
  void reset() { ic1_ = ic2_ = 0; }
  void setMode(Mode m) { mode_ = m; }
  void set(float cutoffHz, float res) {
    float fc = clamp(cutoffHz, 10.f, sr_ * 0.49f);
    float g = std::tan(kPi * fc / sr_);
    k_ = 2.f - 1.95f * clamp(res, 0.f, 1.f);  // Q up to 20
    a1_ = 1.f / (1.f + g * (g + k_));
    a2_ = g * a1_;
    a3_ = g * a2_;
  }

  float process(float x) {
    float v3 = x - ic2_;
    float v1 = a1_ * ic1_ + a2_ * v3;
    float v2 = ic2_ + a2_ * ic1_ + a3_ * v3;
    ic1_ = 2.f * v1 - ic1_;
    ic2_ = 2.f * v2 - ic2_;
    switch (mode_) {
      case Mode::LowPass: return v2;
      case Mode::HighPass: return x - k_ * v1 - v2;
      case Mode::BandPass: return v1;
      case Mode::Notch: return x - k_ * v1;
    }
    return v2;
  }

 private:
  float sr_ = 48000, k_ = 2, a1_ = 0, a2_ = 0, a3_ = 0, ic1_ = 0, ic2_ = 0;
  Mode mode_ = Mode::LowPass;
};

// 4-pole ZDF ladder low-pass with input drive. res 0…1 maps to feedback 0…4
// (self-oscillation at the top). Drive saturates the input and feedback path.
class Ladder {
 public:
  void prepare(float sampleRate) { sr_ = sampleRate; reset(); }
  void reset() { s_[0] = s_[1] = s_[2] = s_[3] = 0; }
  void set(float cutoffHz, float res, float drive = 1.f) {
    float fc = clamp(cutoffHz, 10.f, sr_ * 0.45f);
    float g = std::tan(kPi * fc / sr_);
    G_ = g / (1.f + g);
    k_ = 4.f * clamp(res, 0.f, 1.f);
    drive_ = std::max(drive, 0.01f);
  }

  float process(float x) {
    // Feedback estimate from the current state (linear solve of the loop).
    float G2 = G_ * G_, G4 = G2 * G2;
    float S = G_ * G2 * beta(s_[0]) + G2 * beta(s_[1]) + G_ * beta(s_[2]) + beta(s_[3]);
    float in = softclip(x * drive_);
    float u = (in - k_ * S) / (1.f + k_ * G4);
    u = softclip(u);
    float y = u;
    for (float& s : s_) {
      float v = (y - s) * G_;
      float out = v + s;
      s = out + v;
      y = out;
    }
    // Compensate the passband loss that rises with resonance.
    return y * (1.f + 0.5f * k_) / drive_comp();
  }

 private:
  float beta(float s) const { return s * (1.f - G_); }  // stage state -> output term
  float drive_comp() const { return drive_ > 1.f ? std::sqrt(drive_) : 1.f; }
  float sr_ = 48000, G_ = 0, k_ = 0, drive_ = 1;
  float s_[4] = {0, 0, 0, 0};
};

// One-pole low/high-pass, for tone controls and DC removal.
class OnePole {
 public:
  void prepare(float sampleRate) { sr_ = sampleRate; z_ = 0; }
  void set(float cutoffHz) {
    float g = std::tan(kPi * clamp(cutoffHz, 1.f, sr_ * 0.49f) / sr_);
    G_ = g / (1.f + g);
  }
  float lowpass(float x) { float v = (x - z_) * G_; float y = v + z_; z_ = y + v; return y; }
  float highpass(float x) { return x - lowpass(x); }
  void reset() { z_ = 0; }

 private:
  float sr_ = 48000, G_ = 0, z_ = 0;
};

}  // namespace sk::dsp
