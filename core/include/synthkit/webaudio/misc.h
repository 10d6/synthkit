// StereoPannerNode and DelayNode.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

namespace sk::wa {

// StereoPannerNode's equal-power law. Stereo input keeps both channels and
// pushes one into the other; mono input is placed between them.
struct StereoPanner {
  static void process(float pan, float& l, float& r) {
    pan = std::clamp(pan, -1.f, 1.f);
    constexpr double kHalfPi = 1.57079632679489661923;
    if (pan <= 0) {
      const double x = pan + 1.0;
      const float gl = static_cast<float>(std::cos(kHalfPi * x)), gr = static_cast<float>(std::sin(kHalfPi * x));
      const float il = l, ir = r;
      l = il + ir * gl;
      r = ir * gr;
    } else {
      const double x = pan;
      const float gl = static_cast<float>(std::cos(kHalfPi * x)), gr = static_cast<float>(std::sin(kHalfPi * x));
      const float il = l, ir = r;
      l = il * gl;
      r = ir + il * gr;
    }
  }
  static void processMono(float pan, float in, float& l, float& r) {
    pan = std::clamp(pan, -1.f, 1.f);
    constexpr double kHalfPi = 1.57079632679489661923;
    const double x = (pan + 1.0) / 2.0;
    l = in * static_cast<float>(std::cos(kHalfPi * x));
    r = in * static_cast<float>(std::sin(kHalfPi * x));
  }
};

// DelayNode: write the input, then read `delaySeconds` back with linear
// interpolation (0 delay returns the input itself). The read position is
// worked out in single precision, as the browsers' vectorised code does, so
// the interpolation matches theirs exactly; that's why the buffer is sized
// like theirs (one 128-frame render quantum more than the maximum delay).
class Delay {
 public:
  void prepare(double sampleRate, double maxSeconds) {
    sr_ = static_cast<float>(sampleRate);
    maxSeconds_ = maxSeconds;
    buf_.assign(128 + static_cast<std::size_t>(std::ceil(maxSeconds * sampleRate - 1e-9)), 0.f);
    w_ = 0;
  }
  void reset() { std::fill(buf_.begin(), buf_.end(), 0.f); }
  float process(float x, double delaySeconds) {
    const std::size_t n = buf_.size();
    buf_[w_] = x;
    const float d = static_cast<float>(std::clamp(delaySeconds, 0.0, maxSeconds_)) * sr_;
    const float len = static_cast<float>(n);
    float rp = static_cast<float>(w_) + (len - d);
    if (rp >= len) rp -= len;
    std::size_t i1 = static_cast<std::size_t>(rp);
    if (i1 >= n) i1 -= n;
    std::size_t i2 = i1 + 1;
    if (i2 >= n) i2 -= n;
    const float f = rp - static_cast<float>(i1);
    if (++w_ >= n) w_ = 0;
    return buf_[i1] + f * (buf_[i2] - buf_[i1]);
  }

 private:
  float sr_ = 48000;
  double maxSeconds_ = 0;
  std::vector<float> buf_ = std::vector<float>(129, 0.f);
  std::size_t w_ = 0;
};

}  // namespace sk::wa
