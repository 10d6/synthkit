#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace sk::dsp {

inline constexpr float kPi = 3.14159265358979323846f;
inline constexpr float kTwoPi = 6.28318530717958647692f;

inline float mtof(double note, double a4 = 440.0) {
  return static_cast<float>(a4 * std::exp2((note - 69.0) / 12.0));
}
inline double ftom(double hz, double a4 = 440.0) { return 69.0 + 12.0 * std::log2(hz / a4); }
inline float dbToGain(float db) { return db <= -120.f ? 0.f : std::pow(10.f, db / 20.f); }
inline float gainToDb(float g) { return g <= 1e-6f ? -120.f : 20.f * std::log10(g); }
inline float lerp(float a, float b, float t) { return a + (b - a) * t; }
inline float clamp(float x, float lo, float hi) { return std::min(std::max(x, lo), hi); }

// Smooth saturator, tanh-like, cheap and bounded to (-1, 1).
inline float softclip(float x) {
  x = clamp(x, -3.f, 3.f);
  return x * (27.f + x * x) / (27.f + 9.f * x * x);
}

// Equal-power pan, p in -1 (left) … 1 (right).
inline void panGains(float p, float& l, float& r) {
  float a = (clamp(p, -1.f, 1.f) + 1.f) * 0.25f * kPi;
  l = std::cos(a) * 1.41421356f;
  r = std::sin(a) * 1.41421356f;
}

}  // namespace sk::dsp
