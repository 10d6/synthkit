// WaveShaperNode, including its 2× and 4× oversampling (the browsers'
// windowed-sinc half-band filters, so the latency and the filtering match).
#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <vector>

namespace sk::wa {

namespace detail {

// Doubles the rate: out[2n] = x[n - 64], out[2n+1] = (k * x)[n], 128 taps.
class UpSampler {
 public:
  UpSampler() {
    constexpr double kPi = 3.14159265358979323846, a = 0.16;
    const double a0 = 0.5 * (1 - a), a1 = 0.5, a2 = 0.5 * a;
    for (int i = 0; i < kTaps; ++i) {
      const double s = kPi * (i - kTaps / 2 + 0.5);
      const double sinc = s == 0 ? 1.0 : std::sin(s) / s;
      const double x = (i + 0.5) / kTaps;
      k_[static_cast<std::size_t>(i)] = static_cast<float>(sinc * (a0 - a1 * std::cos(2 * kPi * x) + a2 * std::cos(4 * kPi * x)));
    }
  }
  void reset() { h_.fill(0.f); p_ = 0; }
  void process(float x, float& even, float& odd) {
    h_[static_cast<std::size_t>(p_)] = x;
    float sum = 0;
    for (int j = 0, q = p_; j < kTaps; ++j, q = (q - 1) & (kLen - 1)) sum += k_[static_cast<std::size_t>(j)] * h_[static_cast<std::size_t>(q)];
    even = h_[static_cast<std::size_t>((p_ - kTaps / 2) & (kLen - 1))];
    odd = sum;
    p_ = (p_ + 1) & (kLen - 1);
  }

 private:
  static constexpr int kTaps = 128, kLen = 256;
  std::array<float, kTaps> k_{};
  std::array<float, kLen> h_{};
  int p_ = 0;
};

// Halves the rate: y[n] = sum rk[j] u[2n-1-2j] + 0.5 u[2n-128], 128 taps on
// the odd samples.
class DownSampler {
 public:
  DownSampler() {
    constexpr double kPi = 3.14159265358979323846, a = 0.16;
    const double a0 = 0.5 * (1 - a), a1 = 0.5, a2 = 0.5 * a;
    constexpr int n = 256;
    for (int i = 1; i < n; i += 2) {
      const double s = 0.5 * kPi * (i - n / 2);
      double sinc = s == 0 ? 1.0 : std::sin(s) / s;
      sinc *= 0.5;
      const double x = static_cast<double>(i) / n;
      k_[static_cast<std::size_t>((i - 1) / 2)] = static_cast<float>(sinc * (a0 - a1 * std::cos(2 * kPi * x) + a2 * std::cos(4 * kPi * x)));
    }
  }
  void reset() { u_.fill(0.f); odd_.fill(0.f); up_ = op_ = 0; }
  // One pair of input samples (u[2n], u[2n+1]) in, one output sample y[n] out.
  float process(float u0, float u1) {
    // y[n] uses u[2n - 1] (the previous pair's second sample) and u[2n - 128].
    const float prevOdd = last_;
    odd_[static_cast<std::size_t>(op_)] = prevOdd;
    float sum = 0;
    for (int j = 0, q = op_; j < kTaps; ++j, q = (q - 1) & (kTaps - 1)) sum += k_[static_cast<std::size_t>(j)] * odd_[static_cast<std::size_t>(q)];
    op_ = (op_ + 1) & (kTaps - 1);
    u_[static_cast<std::size_t>(up_)] = u0;
    const float delayed = u_[static_cast<std::size_t>((up_ - 128) & (kLen - 1))];
    u_[static_cast<std::size_t>((up_ + 1) & (kLen - 1))] = u1;
    up_ = (up_ + 2) & (kLen - 1);
    last_ = u1;
    return sum + 0.5f * delayed;
  }

 private:
  static constexpr int kTaps = 128, kLen = 256;
  std::array<float, kTaps> k_{};
  std::array<float, kTaps> odd_{};
  std::array<float, kLen> u_{};
  int up_ = 0, op_ = 0;
  float last_ = 0;
};

}  // namespace detail

class WaveShaper {
 public:
  enum class Oversample { None, X2, X4 };

  // The node's `curve` (copied; allocates, so set it outside the audio
  // thread). An empty curve passes the signal through.
  void setCurve(const float* curve, int length) { curve_.assign(curve, curve + (length > 0 ? length : 0)); }
  void setOversample(Oversample o) {
    if (o != os_) { os_ = o; reset(); }
  }
  void reset() { up1_.reset(); up2_.reset(); down1_.reset(); down2_.reset(); }

  float process(float x) {
    if (curve_.empty()) return x;
    switch (os_) {
      case Oversample::None: return shape(x);
      case Oversample::X2: {
        float a, b;
        up1_.process(x, a, b);
        return down1_.process(shape(a), shape(b));
      }
      case Oversample::X4: {
        float a, b, c, d, e, f;
        up1_.process(x, a, b);
        up2_.process(a, c, d);
        up2_.process(b, e, f);
        // (Sequenced: the order of function arguments isn't defined in C++.)
        const float g = down2_.process(shape(c), shape(d));
        const float k = down2_.process(shape(e), shape(f));
        return down1_.process(g, k);
      }
    }
    return x;
  }

  // The curve lookup itself (WaveShaperNode's mapping of -1…1 onto the curve).
  float shape(float x) const {
    const std::size_t n = curve_.size();
    const double v = 0.5 * (x + 1) * static_cast<double>(n - 1);
    if (v < 0) return curve_[0];
    if (v >= static_cast<double>(n - 1)) return curve_[n - 1];
    const std::size_t i = static_cast<std::size_t>(v);
    const double f = v - static_cast<double>(i);
    return static_cast<float>((1.0 - f) * curve_[i] + f * curve_[i + 1]);
  }

 private:
  std::vector<float> curve_;
  Oversample os_ = Oversample::None;
  detail::UpSampler up1_, up2_;
  detail::DownSampler down1_, down2_;
};

}  // namespace sk::wa
