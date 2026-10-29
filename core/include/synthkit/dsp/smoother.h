#pragma once

#include <cmath>

namespace sk::dsp {

// One-pole smoothing towards a target. `ms` is the time to cover ~63%.
class Smoother {
 public:
  void prepare(float sampleRate, float ms) {
    sr_ = sampleRate;
    setTime(ms);
  }
  void setTime(float ms) { coef_ = ms <= 0 ? 0.f : std::exp(-1.f / (ms * 0.001f * sr_)); }
  void setTarget(float t) { target_ = t; }
  void reset(float v) { value_ = target_ = v; }
  float next() {
    value_ = target_ + (value_ - target_) * coef_;
    return value_;
  }
  // Advance n samples in one step (for control-rate use).
  float advance(int n) {
    value_ = target_ + (value_ - target_) * std::pow(coef_, static_cast<float>(n));
    if (std::fabs(value_ - target_) < 1e-7f) value_ = target_;
    return value_;
  }
  float value() const { return value_; }
  float target() const { return target_; }

 private:
  float sr_ = 48000, coef_ = 0, value_ = 0, target_ = 0;
};

}  // namespace sk::dsp
