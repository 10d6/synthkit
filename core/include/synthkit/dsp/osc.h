#pragma once

#include <cmath>

#include "synthkit/dsp/util.h"

namespace sk::dsp {

// Band-limited oscillator (PolyBLEP / PolyBLAMP). Call setFreq whenever the
// pitch changes (per control block is fine), then next() per sample.
class Osc {
 public:
  enum class Wave { Sine, Saw, Square, Triangle };

  void prepare(float sampleRate) { sr_ = sampleRate; }
  void setWave(Wave w) { wave_ = w; }
  void setFreq(float hz) { dt_ = clamp(hz / sr_, 0.f, 0.49f); }
  void setPulseWidth(float pw) { pw_ = clamp(pw, 0.02f, 0.98f); }
  void reset(float phase = 0) { phase_ = phase - std::floor(phase); }
  float phase() const { return phase_; }

  float next() {
    float p = phase_, y;
    switch (wave_) {
      case Wave::Sine: y = std::sin(kTwoPi * p); break;
      case Wave::Saw: y = 2.f * p - 1.f - blep(p); break;
      case Wave::Square: {
        y = p < pw_ ? 1.f : -1.f;
        y += blep(p);
        float q = p - pw_;
        if (q < 0) q += 1.f;
        y -= blep(q);
        y -= 2.f * pw_ - 1.f;  // remove the DC offset of non-50% pulses
        break;
      }
      case Wave::Triangle: {
        // Naive triangle: -1 at p=0, +1 at p=0.5. The slope flips by 8 per
        // cycle at each corner; BLAMP (scaled by half that, times dt)
        // rounds both corners off.
        y = p < 0.5f ? 4.f * p - 1.f : 3.f - 4.f * p;
        float q = p + 0.5f;
        if (q >= 1.f) q -= 1.f;
        y += 4.f * dt_ * (blamp(p) - blamp(q));
        break;
      }
    }
    phase_ += dt_;
    if (phase_ >= 1.f) phase_ -= 1.f;
    return y;
  }

 private:
  float blep(float t) const {
    if (t < dt_) { t /= dt_; return t + t - t * t - 1.f; }
    if (t > 1.f - dt_) { t = (t - 1.f) / dt_; return t * t + t + t + 1.f; }
    return 0.f;
  }
  float blamp(float t) const {
    if (t < dt_) { t = t / dt_ - 1.f; return -t * t * t / 3.f; }
    if (t > 1.f - dt_) { t = (t - 1.f) / dt_ + 1.f; return t * t * t / 3.f; }
    return 0.f;
  }

  float sr_ = 48000, dt_ = 0, phase_ = 0, pw_ = 0.5f;
  Wave wave_ = Wave::Saw;
};

}  // namespace sk::dsp
