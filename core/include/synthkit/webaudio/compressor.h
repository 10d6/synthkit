// DynamicsCompressorNode, sample for sample: the same knee curve, detector,
// adaptive release, 6 ms look-ahead and make-up gain as the browsers' (it is
// the algorithm Chromium, Firefox and Safari share).
#pragma once

#include <algorithm>
#include <array>
#include <cmath>

namespace sk::wa {

class DynamicsCompressor {
 public:
  void prepare(double sampleRate) {
    sr_ = static_cast<float>(sampleRate);
    meterK_ = static_cast<float>(1 - std::exp(-1 / (sampleRate * 0.325)));
    preDelay_ = std::min(static_cast<unsigned>(0.006f * sr_), kMaxDelay - 1);
    reset();
  }
  void reset() {
    detector_ = 0;
    gain_ = 1;
    meter_ = 1;
    maxAttackDiff_ = -1;
    for (auto& b : buf_) b.fill(0.f);
    read_ = 0;
    write_ = static_cast<int>(preDelay_);
    division_ = 0;
  }

  // The node's AudioParams, in their units: threshold and knee in dB, attack
  // and release in seconds. Defaults: −24, 30, 12, 0.003, 0.25. Read every 32
  // samples, as the browsers do.
  void set(float thresholdDb, float kneeDb, float ratio, float attack, float release) {
    threshold_ = std::clamp(thresholdDb, -100.f, 0.f);
    knee_ = std::clamp(kneeDb, 0.f, 40.f);
    ratio_ = std::clamp(ratio, 1.f, 20.f);
    attack_ = std::clamp(attack, 0.f, 1.f);
    release_ = std::clamp(release, 0.f, 1.f);
  }

  // One stereo frame, in place. The output is the input 6 ms ago times the gain.
  void process(float& l, float& r) {
    if (division_ == 0) beginDivision();
    division_ = (division_ + 1) & 31;

    buf_[0][static_cast<std::size_t>(write_)] = l;
    buf_[1][static_cast<std::size_t>(write_)] = r;
    const float in = std::max(std::fabs(l), std::fabs(r));
    const float shaped = saturate(in, k_);
    const float atten = in <= 0.0001f ? 1 : shaped / in;
    const float dbAtten = std::max(2.0f, -toDb(atten));
    const float satRate = toLinear(dbAtten / (0.0025f * sr_)) - 1;
    detector_ += (atten - detector_) * (atten > detector_ ? satRate : 1.f);
    detector_ = std::min(1.0f, detector_);
    if (!std::isfinite(detector_)) detector_ = 1;

    if (envRate_ < 1) gain_ += (scaledDesired_ - gain_) * envRate_;
    else gain_ = std::min(1.0f, gain_ * envRate_);
    const float warped = static_cast<float>(std::sin(static_cast<double>(kHalfPi * gain_)));
    const float total = postGain_ * warped;
    const float dbReal = toDb(warped);
    meter_ = dbReal < meter_ ? dbReal : meter_ + (dbReal - meter_) * meterK_;

    l = buf_[0][static_cast<std::size_t>(read_)] * total;
    r = buf_[1][static_cast<std::size_t>(read_)] * total;
    read_ = (read_ + 1) & static_cast<int>(kMaxDelay - 1);
    write_ = (write_ + 1) & static_cast<int>(kMaxDelay - 1);
    if (division_ == 0) {
      if (std::fabs(detector_) < 1e-30f) detector_ = 0;
      if (std::fabs(gain_) < 1e-30f) gain_ = 0;
    }
  }

  // The node's `reduction`: current gain reduction in dB (≤ 0).
  float reduction() const { return meter_; }
  // Samples of look-ahead delay (0.006 s).
  int latency() const { return static_cast<int>(preDelay_); }

 private:
  static constexpr unsigned kMaxDelay = 1024;
  static constexpr float kHalfPi = 1.57079632679489661923f;

  static float toDb(float x) { return 20 * std::log10(x); }
  static float toLinear(float db) { return std::pow(10.f, 0.05f * db); }

  float kneeCurve(float x, float k) const {
    if (x < linThreshold_) return x;
    return linThreshold_ + (1 - static_cast<float>(std::exp(static_cast<double>(-k * (x - linThreshold_))))) / k;
  }
  float saturate(float x, float k) const {
    if (x < kneeThreshold_) return kneeCurve(x, k);
    return toLinear(dbYKnee_ + slope_ * (toDb(x) - dbKneeThreshold_));
  }
  float kAtSlope(float desired) const {
    const float dbX = curThreshold_ + curKnee_;
    const float x = toLinear(dbX);
    float x2 = 1, dbX2 = 0;
    if (!(x < linThreshold_)) { x2 = x * 1.001f; dbX2 = toDb(x2); }
    float minK = 0.1f, maxK = 10000, k = 5, slope = 1;
    for (int i = 0; i < 15; ++i) {
      if (!(x < linThreshold_)) slope = (toDb(kneeCurve(x2, k)) - toDb(kneeCurve(x, k))) / (dbX2 - dbX);
      if (slope < desired) maxK = k; else minK = k;
      k = std::sqrt(minK * maxK);
    }
    return k;
  }
  void updateCurve() {
    if (threshold_ == curThreshold_ && knee_ == curKnee_ && ratio_ == curRatio_) return;
    curThreshold_ = threshold_;
    linThreshold_ = toLinear(threshold_);
    curKnee_ = knee_;
    curRatio_ = ratio_;
    slope_ = 1 / ratio_;
    const float k = kAtSlope(1 / ratio_);
    dbKneeThreshold_ = threshold_ + knee_;
    kneeThreshold_ = toLinear(dbKneeThreshold_);
    dbYKnee_ = toDb(kneeCurve(kneeThreshold_, k));
    k_ = k;
  }

  // Once per 32 samples: the target gain and how fast to move towards it.
  void beginDivision() {
    updateCurve();
    postGain_ = std::pow(1 / saturate(1, k_), 0.6f);
    const float attackFrames = std::max(0.001f, attack_) * sr_;
    const float releaseFrames = sr_ * release_;
    constexpr float z1 = 0.09f, z2 = 0.16f, z3 = 0.42f, z4 = 0.98f;  // release zones
    const float a = releaseFrames * (0.9999999999999998f * z1 + 1.8432219684323923e-16f * z2 - 1.9373394351676423e-16f * z3 + 8.824516011816245e-18f * z4);
    const float b = releaseFrames * (-1.5788320352845888f * z1 + 2.3305837032074286f * z2 - 0.9141194204840429f * z3 + 0.1623677525612032f * z4);
    const float c = releaseFrames * (0.5334142869106424f * z1 - 1.272736789213631f * z2 + 0.9258856042207512f * z3 - 0.18656310191776226f * z4);
    const float d = releaseFrames * (0.08783463138207234f * z1 - 0.1694162967925622f * z2 + 0.08588057951595272f * z3 - 0.00429891410546283f * z4);
    const float e = releaseFrames * (-0.042416883008123074f * z1 + 0.1115693827987602f * z2 - 0.09764676325265872f * z3 + 0.028494263462021576f * z4);

    if (!std::isfinite(detector_)) detector_ = 1;
    scaledDesired_ = std::asin(detector_) / kHalfPi;
    const bool releasing = scaledDesired_ > gain_;
    float diff = scaledDesired_ == 0 ? (releasing ? -1.f : 1.f) : toDb(gain_ / scaledDesired_);
    if (releasing) {
      maxAttackDiff_ = -1;
      if (!std::isfinite(diff)) diff = -1;
      float x = 0.25f * (std::clamp(diff, -12.0f, 0.0f) + 12);
      const float x2 = x * x, x3 = x2 * x, x4 = x2 * x2;
      envRate_ = toLinear(5 / (a + b * x + c * x2 + d * x3 + e * x4));
    } else {
      if (!std::isfinite(diff)) diff = 1;
      if (maxAttackDiff_ == -1 || maxAttackDiff_ < diff) maxAttackDiff_ = diff;
      envRate_ = 1 - std::pow(0.25f / std::max(0.5f, maxAttackDiff_), 1 / attackFrames);
    }
  }

  float sr_ = 48000, meterK_ = 0;
  unsigned preDelay_ = 288;
  float threshold_ = -24, knee_ = 30, ratio_ = 12, attack_ = 0.003f, release_ = 0.25f;
  float curThreshold_ = -1, curKnee_ = -1, curRatio_ = -1;
  float linThreshold_ = 0, slope_ = 1, kneeThreshold_ = 0, dbKneeThreshold_ = 0, dbYKnee_ = 0, k_ = 5;
  float postGain_ = 1, envRate_ = 1, scaledDesired_ = 1, maxAttackDiff_ = -1;
  float detector_ = 0, gain_ = 1, meter_ = 1;
  std::array<std::array<float, kMaxDelay>, 2> buf_{};
  int read_ = 0, write_ = 0, division_ = 0;
};

}  // namespace sk::wa
