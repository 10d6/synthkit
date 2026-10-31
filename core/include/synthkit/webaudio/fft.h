// A small complex FFT (radix-2, in place) used by the Web Audio blocks:
// PeriodicWave builds its tables with it and Convolver runs on it. Sizes are
// powers of two. Tables are built in prepare(); transforms never allocate.
#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace sk::wa::detail {

class Fft {
 public:
  void prepare(int size) {
    n_ = size;
    bits_ = 0;
    while ((1 << bits_) < n_) ++bits_;
    cos_.resize(static_cast<std::size_t>(n_ / 2));
    sin_.resize(static_cast<std::size_t>(n_ / 2));
    for (int i = 0; i < n_ / 2; ++i) {
      const double a = 2.0 * 3.14159265358979323846 * i / n_;
      cos_[static_cast<std::size_t>(i)] = static_cast<float>(std::cos(a));
      sin_[static_cast<std::size_t>(i)] = static_cast<float>(std::sin(a));
    }
    rev_.resize(static_cast<std::size_t>(n_));
    for (int i = 0; i < n_; ++i) {
      uint32_t r = 0;
      for (int b = 0; b < bits_; ++b) r |= ((static_cast<uint32_t>(i) >> b) & 1u) << (bits_ - 1 - b);
      rev_[static_cast<std::size_t>(i)] = r;
    }
  }
  int size() const { return n_; }

  // X[k] = sum x[n] e^(-2πikn/N) (forward) or e^(+2πikn/N) (inverse, unscaled).
  void transform(float* re, float* im, bool inverse) const {
    const std::size_t n = static_cast<std::size_t>(n_);
    for (std::size_t i = 0; i < n; ++i) {
      const std::size_t j = rev_[i];
      if (j > i) {
        std::swap(re[i], re[j]);
        std::swap(im[i], im[j]);
      }
    }
    const float sign = inverse ? 1.f : -1.f;
    for (std::size_t len = 2; len <= n; len <<= 1) {
      const std::size_t half = len >> 1, step = n / len;
      for (std::size_t s = 0; s < n; s += len) {
        for (std::size_t k = 0; k < half; ++k) {
          const float wr = cos_[k * step], wi = sign * sin_[k * step];
          const std::size_t a = s + k, b = a + half;
          const float tr = re[b] * wr - im[b] * wi;
          const float ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

 private:
  int n_ = 0, bits_ = 0;
  std::vector<float> cos_, sin_;
  std::vector<uint32_t> rev_;
};

}  // namespace sk::wa::detail
