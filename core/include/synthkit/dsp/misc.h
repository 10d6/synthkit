#pragma once

#include <cmath>
#include <cstddef>
#include <vector>

#include "synthkit/dsp/rng.h"
#include "synthkit/dsp/util.h"

namespace sk::dsp {

class Noise {
 public:
  void seed(uint64_t s) { rng_.seed(s); }
  float white() { return rng_.bipolar(); }
  // Paul Kellet's economy pink filter: within ~1 dB from 40 Hz up.
  float pink() {
    float w = rng_.bipolar();
    b0_ = 0.99765f * b0_ + w * 0.0990460f;
    b1_ = 0.96300f * b1_ + w * 0.2965164f;
    b2_ = 0.57000f * b2_ + w * 1.0526913f;
    return (b0_ + b1_ + b2_ + w * 0.1848f) * 0.25f;
  }

 private:
  Rng rng_;
  float b0_ = 0, b1_ = 0, b2_ = 0;
};

// Fractional delay line with cubic (Hermite) interpolation. Size it in
// prepare; read/write never allocate.
class Delay {
 public:
  void prepare(float sampleRate, float maxSeconds) {
    sr_ = sampleRate;
    std::size_t n = static_cast<std::size_t>(std::ceil(maxSeconds * sampleRate)) + 4;
    buf_.assign(n, 0.f);
    w_ = 0;
  }
  void reset() { std::fill(buf_.begin(), buf_.end(), 0.f); }
  void write(float x) {
    buf_[w_] = flushDenormal(x);
    if (++w_ >= buf_.size()) w_ = 0;
  }
  // Delay in samples, >= 1. Read before write for a standard feedback delay.
  float read(float samples) const {
    float maxD = static_cast<float>(buf_.size() - 3);
    samples = clamp(samples, 1.f, maxD);
    float pos = static_cast<float>(w_) - samples;
    while (pos < 0) pos += static_cast<float>(buf_.size());
    std::size_t i1 = static_cast<std::size_t>(pos);
    float f = pos - static_cast<float>(i1);
    std::size_t n = buf_.size();
    float y0 = buf_[(i1 + n - 1) % n], y1 = buf_[i1 % n], y2 = buf_[(i1 + 1) % n], y3 = buf_[(i1 + 2) % n];
    float c1 = 0.5f * (y2 - y0);
    float c2 = y0 - 2.5f * y1 + 2.f * y2 - 0.5f * y3;
    float c3 = 0.5f * (y3 - y0) + 1.5f * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }
  float readSeconds(float s) const { return read(s * sr_); }

 private:
  float sr_ = 48000;
  std::vector<float> buf_ = std::vector<float>(8, 0.f);
  std::size_t w_ = 0;
};

// Stereo-linked peak limiter without lookahead: instant attack, smooth
// release, then a hard ceiling. A safety net, not a mastering tool.
class Limiter {
 public:
  void prepare(float sampleRate, float ceilingDb = -0.3f, float releaseMs = 80.f) {
    ceiling_ = dbToGain(ceilingDb);
    rel_ = std::exp(-1.f / (releaseMs * 0.001f * sampleRate));
    gain_ = 1.f;
  }
  void process(float& l, float& r) {
    float peak = std::max(std::fabs(l), std::fabs(r));
    float want = peak * gain_ > ceiling_ ? ceiling_ / peak : 1.f;
    gain_ = want < gain_ ? want : std::min(want, 1.f + (gain_ - 1.f) * rel_);
    if (gain_ < minGain_) minGain_ = gain_;
    l = clamp(l * gain_, -ceiling_, ceiling_);
    r = clamp(r * gain_, -ceiling_, ceiling_);
  }
  // Largest gain reduction since the last call, in dB (>= 0).
  float takeMaxReductionDb() {
    float db = -gainToDb(minGain_);
    minGain_ = 1.f;
    return db < 0 ? 0 : db;
  }

 private:
  float ceiling_ = 1, rel_ = 0.999f, gain_ = 1, minGain_ = 1;
};

}  // namespace sk::dsp
