// PeriodicWave and OscillatorNode: band-limited wavetables built from
// Fourier coefficients, played back exactly as the browsers do (the same
// table sizes, 3 tables per octave, crossfading between neighbouring tables,
// and linear or Lagrange interpolation within a table).
#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

#include "synthkit/webaudio/fft.h"

namespace sk::wa {

class PeriodicWave {
 public:
  enum class Basic { Sine, Square, Sawtooth, Triangle };

  // createPeriodicWave(real, imag, {disableNormalization}). real[k] is the
  // cosine and imag[k] the sine amplitude of harmonic k; index 0 is ignored.
  // Builds the tables, so it allocates: call it outside the audio thread
  // (prepare, or a UI thread, then hand the finished wave over).
  void build(double sampleRate, const float* real, const float* imag, int count, bool disableNormalization = false) {
    size_ = sampleRate <= 24000 ? 2048 : sampleRate <= 88200 ? 4096 : 16384;
    ranges_ = static_cast<int>(std::lround(3 * std::log2(static_cast<float>(size_))));
    lowest_ = static_cast<float>(sampleRate) / static_cast<float>(size_);
    rateScale_ = static_cast<float>(size_) / static_cast<float>(sampleRate);
    const int half = size_ / 2;
    const int comps = std::min(count, half);
    detail::Fft fft;
    fft.prepare(size_);
    std::vector<float> re(static_cast<std::size_t>(size_)), im(static_cast<std::size_t>(size_));
    tables_.assign(static_cast<std::size_t>(ranges_) * static_cast<std::size_t>(size_), 0.f);
    float norm = 0.5f;
    for (int r = 0; r < ranges_; ++r) {
      const unsigned partials = static_cast<unsigned>(static_cast<float>(std::pow(2, -(r * (1200.f / 3)) / 1200.f)) * static_cast<float>(half));
      const int keep = std::min(comps, static_cast<int>(partials) + 1);
      std::fill(re.begin(), re.end(), 0.f);
      std::fill(im.begin(), im.end(), 0.f);
      // Hermitian spectrum of sum(a cos + b sin) times 2, as the browsers'
      // inverse FFT produces before their 0.5 scale.
      for (int k = 1; k < keep; ++k) {
        const float a = real ? real[k] : 0.f, b = imag ? imag[k] : 0.f;
        re[static_cast<std::size_t>(k)] = a;
        im[static_cast<std::size_t>(k)] = -b;
        re[static_cast<std::size_t>(size_ - k)] = a;
        im[static_cast<std::size_t>(size_ - k)] = b;
      }
      fft.transform(re.data(), im.data(), true);
      float* t = tables_.data() + static_cast<std::size_t>(r) * static_cast<std::size_t>(size_);
      for (int i = 0; i < size_; ++i) t[i] = re[static_cast<std::size_t>(i)];
      if (!disableNormalization && r == 0) {
        float mx = 0;
        for (int i = 0; i < size_; ++i) mx = std::max(mx, std::fabs(t[i]));
        if (mx > 0) norm = 1.0f / mx;
      }
      for (int i = 0; i < size_; ++i) t[i] *= norm;
    }
  }

  // The built-in OscillatorNode types.
  void build(double sampleRate, Basic shape) {
    const int half = (sampleRate <= 24000 ? 2048 : sampleRate <= 88200 ? 4096 : 16384) / 2;
    std::vector<float> real(static_cast<std::size_t>(half), 0.f), imag(static_cast<std::size_t>(half), 0.f);
    for (int n = 1; n < half; ++n) {
      const float pf = 2 / (static_cast<float>(n) * 3.14159265358979323846f);
      float b = 0;
      switch (shape) {
        case Basic::Sine: b = n == 1 ? 1.f : 0.f; break;
        case Basic::Square: b = (n & 1) ? 2 * pf : 0.f; break;
        case Basic::Sawtooth: b = pf * ((n & 1) ? 1.f : -1.f); break;
        case Basic::Triangle: b = (n & 1) ? 2 * (pf * pf) * ((((n - 1) >> 1) & 1) ? -1.f : 1.f) : 0.f; break;
      }
      imag[static_cast<std::size_t>(n)] = b;
    }
    build(sampleRate, real.data(), imag.data(), half, false);
  }

  bool ready() const { return !tables_.empty(); }
  int tableSize() const { return size_; }
  float rateScale() const { return rateScale_; }

  // Which two tables to crossfade for a fundamental, and by how much.
  void tablesFor(float hz, const float*& lower, const float*& higher, float& mix) const {
    hz = std::fabs(hz);
    const float ratio = hz > 0 ? hz / lowest_ : 0.5f;
    const float cents = std::log2(ratio) * 1200;
    const float range = std::clamp(1 + cents / (1200.f / 3), 0.0f, static_cast<float>(ranges_ - 1));
    const int r1 = static_cast<int>(range);
    const int r2 = r1 < ranges_ - 1 ? r1 + 1 : r1;
    lower = tables_.data() + static_cast<std::size_t>(r2) * static_cast<std::size_t>(size_);
    higher = tables_.data() + static_cast<std::size_t>(r1) * static_cast<std::size_t>(size_);
    mix = range - static_cast<float>(r1);
  }

 private:
  int size_ = 4096, ranges_ = 36;
  float lowest_ = 1, rateScale_ = 1;
  std::vector<float> tables_;
};

class Oscillator {
 public:
  void prepare(double sampleRate) { sr_ = static_cast<float>(sampleRate); }
  // The wave isn't owned: keep it alive while the oscillator uses it. Several
  // oscillators can share one.
  void setWave(const PeriodicWave* w) { wave_ = w; }
  // Start phase, 0…1 of a cycle (an OscillatorNode starts at 0).
  void reset(double phase = 0) { index_ = wave_ ? phase * wave_->tableSize() : 0; }

  // One sample at this frequency (Hz, including detune: hz * 2^(cents/1200)).
  // Passing a new frequency every sample is the a-rate case.
  float next(float hz) {
    if (!wave_ || !wave_->ready()) return 0;
    const float nyq = sr_ / 2;
    hz = std::isnan(hz) ? nyq : std::clamp(hz, -nyq, nyq);
    const int size = wave_->tableSize();
    const unsigned mask = static_cast<unsigned>(size - 1);
    const float incr = hz * wave_->rateScale();
    const float* lower;
    const float* higher;
    float mix;
    wave_->tablesFor(incr / wave_->rateScale(), lower, higher, mix);
    const float s = interpolate(index_, std::fabs(incr), mask, mix, lower, higher);
    index_ += incr;
    index_ -= std::floor(index_ / size) * size;
    return s;
  }

 private:
  static float interpolate(double vi, float incr, unsigned mask, float mix, const float* lower, const float* higher) {
    double lo = 0, hi = 0;
    unsigned i0 = static_cast<unsigned>(vi);
    if (incr >= 0.3f) {
      const float f = static_cast<float>(vi) - static_cast<float>(i0);
      const unsigned a = i0 & mask, b = (i0 + 1) & mask;
      hi = higher[a] + f * (higher[b] - higher[a]);
      lo = lower[a] + f * (lower[b] - lower[a]);
    } else if (incr >= 0.16f) {
      const double t = vi - i0;
      const double c[3] = {0.5 * t * (t - 1), 1 - t * t, 0.5 * t * (t + 1)};
      for (int k = -1; k <= 1; ++k) {
        const unsigned idx = (i0 + static_cast<unsigned>(k)) & mask;
        lo += c[k + 1] * lower[idx];
        hi += c[k + 1] * higher[idx];
      }
    } else {
      const double t = vi - i0, t2 = t * t;
      const double c[5] = {t * (t2 - 1) * (t - 2) / 24, -t * (t - 1) * (t2 - 4) / 6, (t2 - 1) * (t2 - 4) / 4,
                           -t * (t + 1) * (t2 - 4) / 6, t * (t2 - 1) * (t + 2) / 24};
      for (int k = -2; k <= 2; ++k) {
        const unsigned idx = (i0 + static_cast<unsigned>(k)) & mask;
        lo += c[k + 2] * lower[idx];
        hi += c[k + 2] * higher[idx];
      }
    }
    return static_cast<float>(hi) + mix * (static_cast<float>(lo) - static_cast<float>(hi));
  }

  const PeriodicWave* wave_ = nullptr;
  float sr_ = 48000;
  double index_ = 0;
};

}  // namespace sk::wa
