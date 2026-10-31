// BiquadFilterNode, sample for sample.
#pragma once

#include <algorithm>
#include <cmath>
#include <complex>

namespace sk::wa {

class BiquadFilter {
 public:
  enum class Type { Lowpass, Highpass, Bandpass, Lowshelf, Highshelf, Peaking, Notch, Allpass };

  void prepare(double sampleRate) {
    sr_ = sampleRate;
    reset();
    update();
  }
  void reset() { x1_ = x2_ = y1_ = y2_ = 0; }

  void setType(Type t) {
    if (t != type_) { type_ = t; update(); }
  }
  Type type() const { return type_; }

  // The node's four AudioParams. frequency is clamped to 0…Nyquist, like the
  // node's. Q is in dB for lowpass and highpass (as in Web Audio), linear
  // otherwise. gain (dB) is used by the shelves and peaking. Recomputes the
  // coefficients only when something changed, so calling it every sample with
  // the same values is cheap.
  void set(float frequency, float Q, float gainDb = 0, float detuneCents = 0) {
    frequency = std::clamp(frequency, 0.f, static_cast<float>(sr_ / 2));
    if (frequency == f_ && Q == q_ && gainDb == g_ && detuneCents == d_) return;
    f_ = frequency;
    q_ = Q;
    g_ = gainDb;
    d_ = detuneCents;
    update();
  }

  float process(float x) {
    // As in Chromium: double arithmetic, float output, float output history.
    const float y = static_cast<float>(b0_ * x + b1_ * x1_ + b2_ * x2_ - a1_ * y1_ - a2_ * y2_);
    x2_ = x1_;
    x1_ = x;
    y2_ = y1_;
    y1_ = y;
    return y;
  }
  // Call once per block (not per sample) to keep decaying states out of the
  // denormal range.
  void flush() {
    auto f = [](double& v) { if (std::fabs(v) < 1e-30) v = 0; };
    f(x1_); f(x2_); f(y1_); f(y2_);
  }

  // getFrequencyResponse for one frequency in Hz.
  double magnitude(double hz) const { return std::abs(response(hz)); }
  double phase(double hz) const { return std::arg(response(hz)); }

 private:
  std::complex<double> response(double hz) const {
    const double w = 3.14159265358979323846 * hz / (sr_ / 2);
    const std::complex<double> z = std::polar(1.0, -w), z2 = z * z;
    return (b0_ + b1_ * z + b2_ * z2) / (1.0 + a1_ * z + a2_ * z2);
  }

  void coeffs(double b0, double b1, double b2, double a0, double a1, double a2) {
    const double inv = 1 / a0;
    b0_ = b0 * inv; b1_ = b1 * inv; b2_ = b2 * inv; a1_ = a1 * inv; a2_ = a2 * inv;
  }

  void update() {
    constexpr double kPi = 3.14159265358979323846;
    double fn = f_ / (sr_ / 2);
    if (d_ != 0) fn *= std::exp2(d_ / 1200.0);
    const double A = std::pow(10.0, g_ / 40.0);
    const double q = q_;
    switch (type_) {
      case Type::Lowpass:
      case Type::Highpass: {
        const bool lp = type_ == Type::Lowpass;
        fn = std::clamp(fn, 0.0, 1.0);
        if (fn == 1) { lp ? coeffs(1, 0, 0, 1, 0, 0) : coeffs(0, 0, 0, 1, 0, 0); break; }
        if (fn <= 0) { lp ? coeffs(0, 0, 0, 1, 0, 0) : coeffs(1, 0, 0, 1, 0, 0); break; }
        const double res = std::pow(10.0, q / 20.0);
        const double th = kPi * fn, alpha = std::sin(th) / (2 * res), c = std::cos(th);
        const double beta = lp ? (1 - c) / 2 : (1 + c) / 2;
        coeffs(beta, lp ? 2 * beta : -2 * beta, beta, 1 + alpha, -2 * c, 1 - alpha);
        break;
      }
      case Type::Lowshelf:
      case Type::Highshelf: {
        const bool lo = type_ == Type::Lowshelf;
        fn = std::clamp(fn, 0.0, 1.0);
        if (fn == 1) { lo ? coeffs(A * A, 0, 0, 1, 0, 0) : coeffs(1, 0, 0, 1, 0, 0); break; }
        if (fn <= 0) { lo ? coeffs(1, 0, 0, 1, 0, 0) : coeffs(A * A, 0, 0, 1, 0, 0); break; }
        const double w0 = kPi * fn;
        const double alpha = 0.5 * std::sin(w0) * std::sqrt((A + 1 / A) * (1 / 1.0 - 1) + 2);  // slope S = 1
        const double k = std::cos(w0), k2 = 2 * std::sqrt(A) * alpha, ap = A + 1, am = A - 1;
        if (lo)
          coeffs(A * (ap - am * k + k2), 2 * A * (am - ap * k), A * (ap - am * k - k2),
                 ap + am * k + k2, -2 * (am + ap * k), ap + am * k - k2);
        else
          coeffs(A * (ap + am * k + k2), -2 * A * (am + ap * k), A * (ap + am * k - k2),
                 ap - am * k + k2, 2 * (am - ap * k), ap - am * k - k2);
        break;
      }
      case Type::Peaking:
      case Type::Notch:
      case Type::Allpass: {
        fn = std::clamp(fn, 0.0, 1.0);
        const double qq = std::max(0.0, q);
        if (!(fn > 0 && fn < 1)) { coeffs(1, 0, 0, 1, 0, 0); break; }
        if (qq <= 0) {
          if (type_ == Type::Peaking) coeffs(A * A, 0, 0, 1, 0, 0);
          else if (type_ == Type::Notch) coeffs(0, 0, 0, 1, 0, 0);
          else coeffs(-1, 0, 0, 1, 0, 0);
          break;
        }
        const double w0 = kPi * fn, alpha = std::sin(w0) / (2 * qq), k = std::cos(w0);
        if (type_ == Type::Peaking) coeffs(1 + alpha * A, -2 * k, 1 - alpha * A, 1 + alpha / A, -2 * k, 1 - alpha / A);
        else if (type_ == Type::Notch) coeffs(1, -2 * k, 1, 1 + alpha, -2 * k, 1 - alpha);
        else coeffs(1 - alpha, -2 * k, 1 + alpha, 1 + alpha, -2 * k, 1 - alpha);
        break;
      }
      case Type::Bandpass: {
        fn = std::max(0.0, fn);
        const double qq = std::max(0.0, q);
        if (!(fn > 0 && fn < 1)) { coeffs(0, 0, 0, 1, 0, 0); break; }
        if (qq <= 0) { coeffs(1, 0, 0, 1, 0, 0); break; }
        const double w0 = kPi * fn, alpha = std::sin(w0) / (2 * qq), k = std::cos(w0);
        coeffs(alpha, 0, -alpha, 1 + alpha, -2 * k, 1 - alpha);
        break;
      }
    }
  }

  double sr_ = 48000;
  Type type_ = Type::Lowpass;
  float f_ = 350, q_ = 1, g_ = 0, d_ = 0;   // the node's defaults
  double b0_ = 1, b1_ = 0, b2_ = 0, a1_ = 0, a2_ = 0;
  double x1_ = 0, x2_ = 0, y1_ = 0, y2_ = 0;
};

}  // namespace sk::wa
