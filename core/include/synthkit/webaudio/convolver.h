// ConvolverNode: exact (zero-latency) convolution with an impulse response,
// with Web Audio's normalisation and channel routing.
//
// The response is split into a short head, convolved directly, and then
// partitions of 64, 256, 1024 and 4096 samples convolved with FFTs. Work is
// done one sample at a time, with an FFT step whenever a partition's worth of
// input has arrived, so the most work in any one sample is a few 8192-point
// FFTs (well under a millisecond) — fine on the audio thread.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

#include "synthkit/webaudio/fft.h"

namespace sk::wa {

namespace detail {

// One channel: x convolved with h, with no latency.
class PartitionedConvolver {
 public:
  void load(const float* h, int length, float scale) {
    levels_.clear();
    head_.assign(h, h + std::min(length, kHead));
    for (float& v : head_) v *= scale;
    hist_.assign(static_cast<std::size_t>(kHead), 0.f);
    histPos_ = 0;
    int offset = kHead;
    // Partition sizes and how far each level reaches (each starts at an
    // offset at least its own size, which hides its one-block latency).
    struct Plan { int n, upTo; };
    const Plan plans[] = {{64, 512}, {256, 2048}, {1024, 8192}, {4096, 1 << 30}};
    int ringNeed = 1;
    for (const Plan& p : plans) {
      if (offset >= length) break;
      const int end = std::min(length, p.upTo);
      Level lv;
      lv.n = p.n;
      lv.offset = offset;
      lv.parts = (end - offset + p.n - 1) / p.n;
      lv.fft.prepare(2 * p.n);
      const std::size_t bins = static_cast<std::size_t>(2 * p.n);
      lv.hre.assign(bins * static_cast<std::size_t>(lv.parts), 0.f);
      lv.him.assign(bins * static_cast<std::size_t>(lv.parts), 0.f);
      for (int m = 0; m < lv.parts; ++m) {
        float* re = lv.hre.data() + bins * static_cast<std::size_t>(m);
        float* im = lv.him.data() + bins * static_cast<std::size_t>(m);
        for (int i = 0; i < p.n; ++i) {
          const int t = offset + m * p.n + i;
          re[i] = t < length ? h[t] * scale : 0.f;
        }
        lv.fft.transform(re, im, false);
      }
      lv.xre.assign(bins * static_cast<std::size_t>(lv.parts), 0.f);
      lv.xim.assign(bins * static_cast<std::size_t>(lv.parts), 0.f);
      lv.in.assign(static_cast<std::size_t>(p.n), 0.f);
      lv.wre.assign(bins, 0.f);
      lv.wim.assign(bins, 0.f);
      ringNeed = std::max(ringNeed, offset + 2 * p.n + 1);
      levels_.push_back(std::move(lv));
      offset = end;
    }
    ring_ = 1;
    while (ring_ < ringNeed) ring_ <<= 1;
    out_.assign(static_cast<std::size_t>(ring_), 0.f);
    pos_ = 0;
  }

  void reset() {
    std::fill(hist_.begin(), hist_.end(), 0.f);
    std::fill(out_.begin(), out_.end(), 0.f);
    for (auto& lv : levels_) {
      std::fill(lv.xre.begin(), lv.xre.end(), 0.f);
      std::fill(lv.xim.begin(), lv.xim.end(), 0.f);
      lv.fill = 0;
      lv.slot = 0;
    }
  }

  float process(float x) {
    // Direct head.
    hist_[static_cast<std::size_t>(histPos_)] = x;
    float y = 0;
    const int nh = static_cast<int>(head_.size());
    for (int k = 0, p = histPos_; k < nh; ++k, p = (p - 1) & (kHead - 1)) y += head_[static_cast<std::size_t>(k)] * hist_[static_cast<std::size_t>(p)];
    histPos_ = (histPos_ + 1) & (kHead - 1);

    const std::size_t mask = static_cast<std::size_t>(ring_ - 1);
    y += out_[static_cast<std::size_t>(pos_) & mask];
    out_[static_cast<std::size_t>(pos_) & mask] = 0;

    for (auto& lv : levels_) {
      lv.in[static_cast<std::size_t>(lv.fill++)] = x;
      if (lv.fill == lv.n) { runLevel(lv, mask); lv.fill = 0; }
    }
    ++pos_;
    return y;
  }

  bool empty() const { return head_.empty(); }

 private:
  static constexpr int kHead = 64;

  struct Level {
    int n = 0, offset = 0, parts = 0, fill = 0, slot = 0;
    Fft fft;
    std::vector<float> hre, him;   // partition spectra
    std::vector<float> xre, xim;   // recent input spectra (frequency-domain delay line)
    std::vector<float> in, wre, wim;
  };

  // A block of n inputs has arrived (the last at sample pos_). Its block
  // started at pos_ - n + 1; contributions start `offset` later.
  void runLevel(Level& lv, std::size_t mask) {
    const std::size_t bins = static_cast<std::size_t>(2 * lv.n);
    lv.slot = (lv.slot + 1) % lv.parts;
    float* xr = lv.xre.data() + bins * static_cast<std::size_t>(lv.slot);
    float* xi = lv.xim.data() + bins * static_cast<std::size_t>(lv.slot);
    std::copy(lv.in.begin(), lv.in.end(), xr);
    std::fill(xr + lv.n, xr + bins, 0.f);
    std::fill(xi, xi + bins, 0.f);
    lv.fft.transform(xr, xi, false);

    std::fill(lv.wre.begin(), lv.wre.end(), 0.f);
    std::fill(lv.wim.begin(), lv.wim.end(), 0.f);
    for (int m = 0; m < lv.parts; ++m) {
      const int s = (lv.slot - m + lv.parts) % lv.parts;
      const float* ar = lv.xre.data() + bins * static_cast<std::size_t>(s);
      const float* ai = lv.xim.data() + bins * static_cast<std::size_t>(s);
      const float* br = lv.hre.data() + bins * static_cast<std::size_t>(m);
      const float* bi = lv.him.data() + bins * static_cast<std::size_t>(m);
      for (std::size_t k = 0; k < bins; ++k) {
        lv.wre[k] += ar[k] * br[k] - ai[k] * bi[k];
        lv.wim[k] += ar[k] * bi[k] + ai[k] * br[k];
      }
    }
    lv.fft.transform(lv.wre.data(), lv.wim.data(), true);
    const float inv = 1.f / static_cast<float>(bins);
    const long start = pos_ - lv.n + 1 + lv.offset;
    for (std::size_t i = 0; i < bins; ++i) out_[static_cast<std::size_t>(start + static_cast<long>(i)) & mask] += lv.wre[i] * inv;
  }

  std::vector<float> head_, hist_, out_;
  int histPos_ = 0, ring_ = 1;
  long pos_ = 0;
  std::vector<Level> levels_;
};

}  // namespace detail

class Convolver {
 public:
  // Sets the impulse response (1 or 2 channels) — the node's `buffer`, with
  // its `normalize` flag (default true, as in Web Audio). This allocates:
  // call it from prepare() or another non-audio thread before audio runs,
  // like loading a sample. sampleRate is the response's own rate, which Web
  // Audio's normalisation uses.
  void setImpulse(const float* const* channels, int numChannels, int length, double sampleRate, bool normalize = true) {
    numChannels = std::clamp(numChannels, 1, 2);
    float scale = 1;
    if (normalize && length > 0) {
      float power = 0;
      for (int c = 0; c < numChannels; ++c) {
        float p = 0;
        for (int i = 0; i < length; ++i) p += channels[c][i] * channels[c][i];
        power += p;
      }
      power = std::sqrt(power / static_cast<float>(numChannels * length));
      if (!std::isfinite(power) || power < 0.000125f) power = 0.000125f;
      scale = 1 / power * std::pow(10.f, -58 * 0.05f);
      if (sampleRate > 0) scale *= static_cast<float>(44100 / sampleRate);
    }
    stereoIr_ = numChannels == 2;
    for (int c = 0; c < 2; ++c) ch_[c].load(channels[std::min(c, numChannels - 1)], length, scale);
  }
  void reset() { ch_[0].reset(); ch_[1].reset(); }

  // Stereo in, stereo out (left with the first response channel, right with
  // the second, or both with a mono response).
  void process(float& l, float& r) {
    l = ch_[0].process(l);
    r = ch_[1].process(r);
  }
  // Mono in: with a stereo response, out comes stereo; with a mono one, l == r.
  void processMono(float in, float& l, float& r) {
    l = ch_[0].process(in);
    r = stereoIr_ ? ch_[1].process(in) : l;
  }

 private:
  detail::PartitionedConvolver ch_[2];
  bool stereoIr_ = false;
};

}  // namespace sk::wa
