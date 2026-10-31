// AudioParam automation: setValueAtTime, the two ramps, setTargetAtTime,
// setValueCurveAtTime, cancelScheduledValues and cancelAndHoldAtTime, with
// the Web Audio spec's rules for how events follow each other. Times are
// seconds on whatever clock the synth keeps (like ctx.currentTime).
//
// Scheduling never allocates once the Param has room (reserve() in prepare);
// a full Param refuses new events and returns false.
#pragma once

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstddef>
#include <vector>

namespace sk::wa {

class Param {
 public:
  explicit Param(float defaultValue = 0, float minValue = -FLT_MAX, float maxValue = FLT_MAX)
      : value_(defaultValue), last_(defaultValue), min_(minValue), max_(maxValue) {
    reserve(32, 256);
  }

  // Room for this many pending events and curve points (allocates). The
  // default is 32 events and 256 curve points.
  void reserve(int events, int curvePoints) {
    ev_.reserve(static_cast<std::size_t>(events));
    curves_.reserve(static_cast<std::size_t>(curvePoints));
  }
  void setRange(float minValue, float maxValue) { min_ = minValue; max_ = maxValue; }

  // The `value` attribute. Setting it with events pending is
  // setValueAtTime(v, the time last processed), as in Web Audio.
  float value() const { return last_; }
  void setValue(float v) {
    if (ev_.empty()) { value_ = v; last_ = clamp(v); }
    else setValueAtTime(v, now_);
  }

  bool setValueAtTime(float v, double t) { return insert(Ev{Type::Set, std::max(t, 0.0), v}); }
  bool linearRampToValueAtTime(float v, double t) { return ramp(Type::Linear, v, t); }
  bool exponentialRampToValueAtTime(float v, double t) { return v != 0 && ramp(Type::Exp, v, t); }
  bool setTargetAtTime(float target, double t, double timeConstant) {
    if (timeConstant < 0) return false;
    Ev e{Type::Target, std::max(t, 0.0), target};
    e.tau = timeConstant;
    return insert(e);
  }
  bool setValueCurveAtTime(const float* curve, int length, double t, double duration) {
    if (length < 2 || duration <= 0) return false;
    t = std::max(t, 0.0);
    // Curves may not overlap other events.
    for (const Ev& e : ev_)
      if (e.time > t && e.time < t + duration) return false;
    compactCurves();
    if (curves_.size() + static_cast<std::size_t>(length) > curves_.capacity() || ev_.size() + 2 > ev_.capacity()) return false;
    Ev e{Type::Curve, t, curve[length - 1]};
    e.curveAt = static_cast<int>(curves_.size());
    e.curveLen = length;
    e.duration = duration;
    curves_.insert(curves_.end(), curve, curve + length);
    return insert(e) && insert(Ev{Type::Set, t + duration, curve[length - 1]});
  }
  void cancelScheduledValues(double t) {
    ev_.erase(std::remove_if(ev_.begin(), ev_.end(), [t](const Ev& e) { return e.time >= t; }), ev_.end());
    cursor_ = std::min(cursor_, static_cast<int>(ev_.size()) - 1);
  }
  void cancelAndHoldAtTime(double t) {
    const float v = peek(t);
    int next = -1;
    for (int i = 0; i < static_cast<int>(ev_.size()); ++i)
      if (ev_[static_cast<std::size_t>(i)].time > t) { next = i; break; }
    const bool nextRamp = next >= 0 && isRamp(ev_[static_cast<std::size_t>(next)].type);
    const Type rampType = nextRamp ? ev_[static_cast<std::size_t>(next)].type : Type::Set;
    ev_.erase(std::remove_if(ev_.begin(), ev_.end(), [t](const Ev& e) { return e.time > t; }), ev_.end());
    cursor_ = std::min(cursor_, static_cast<int>(ev_.size()) - 1);
    if (ev_.size() < ev_.capacity()) ev_.push_back(Ev{nextRamp ? rampType : Type::Set, t, v});
  }

  // The value at time t (non-decreasing from call to call), clamped to the
  // param's range: what the param outputs at that sample.
  float valueAt(double t) {
    now_ = t;
    while (cursor_ + 1 < static_cast<int>(ev_.size()) && ev_[static_cast<std::size_t>(cursor_ + 1)].time <= t) {
      ++cursor_;
      enter(cursor_);
    }
    // Events behind the cursor are no longer needed.
    if (cursor_ > 0) {
      ev_.erase(ev_.begin(), ev_.begin() + cursor_);
      cursor_ = 0;
    }
    last_ = clamp(evalWith(cursor_, t));
    return last_;
  }
  // n values starting at t0, dt apart (a block of a-rate values).
  void fill(double t0, double dt, float* out, int n) {
    for (int i = 0; i < n; ++i) out[i] = valueAt(t0 + i * dt);
  }
  bool automated() const { return !ev_.empty(); }

 private:
  enum class Type { Set, Linear, Exp, Target, Curve };
  struct Ev {
    Type type;
    double time;
    float value;
    double tau = 0, duration = 0;
    int curveAt = 0, curveLen = 0;
    double t0 = 0;    // ramps: start time; targets: (unused)
    float v0 = 0;     // ramps: start value; targets: value when they began
  };
  static bool isRamp(Type t) { return t == Type::Linear || t == Type::Exp; }
  float clamp(float v) const { return std::isnan(v) ? value_ : std::clamp(v, min_, max_); }

  bool ramp(Type type, float v, double t) {
    t = std::max(t, 0.0);
    Ev e{type, t, v};
    // A ramp with nothing before it starts from now and the current value.
    e.t0 = now_;
    e.v0 = last_;
    // A ramp after a SetTarget replaces it if it hasn't begun, or cuts it
    // here if it has, so the curve stays continuous (spec §1.6.3).
    int prev = -1;
    for (int i = 0; i < static_cast<int>(ev_.size()); ++i)
      if (ev_[static_cast<std::size_t>(i)].time <= t) prev = i;
    if (prev >= 0 && ev_[static_cast<std::size_t>(prev)].type == Type::Target) {
      const Ev tgt = ev_[static_cast<std::size_t>(prev)];
      if (tgt.time > now_) {
        const float before = peekBefore(prev, tgt.time);
        ev_[static_cast<std::size_t>(prev)] = Ev{Type::Set, tgt.time, before};
      } else if (!insert(Ev{Type::Set, now_, peek(now_)})) {
        return false;
      }
    }
    return insert(e);
  }

  bool insert(const Ev& e) {
    if (ev_.size() >= ev_.capacity()) return false;
    for (const Ev& c : ev_)
      if (c.type == Type::Curve && e.time > c.time && e.time < c.time + c.duration) return false;
    auto at = std::upper_bound(ev_.begin(), ev_.end(), e.time, [](double t, const Ev& x) { return t < x.time; });
    const int idx = static_cast<int>(at - ev_.begin());
    ev_.insert(at, e);
    if (idx <= cursor_) {
      // Inserted at or before the current time: recompute where we are.
      cursor_ = -1;
      while (cursor_ + 1 < static_cast<int>(ev_.size()) && ev_[static_cast<std::size_t>(cursor_ + 1)].time <= now_) {
        ++cursor_;
        enter(cursor_);
      }
    }
    return true;
  }

  // The cursor reaches event i: note what it starts from.
  void enter(int i) {
    Ev& e = ev_[static_cast<std::size_t>(i)];
    if (e.type == Type::Target) e.v0 = peekBefore(i, e.time);
  }

  // Value at t as scheduled, without moving the cursor.
  float peek(double t) const {
    int last = -1;
    for (int i = 0; i < static_cast<int>(ev_.size()); ++i)
      if (ev_[static_cast<std::size_t>(i)].time <= t) last = i;
    if (last >= 0 && ev_[static_cast<std::size_t>(last)].type == Type::Target) {
      Ev tmp = ev_[static_cast<std::size_t>(last)];
      tmp.v0 = targetStart(last);
      return clamp(targetValue(tmp, t));
    }
    return clamp(evalWith(last, t));
  }
  // Value at t from the events before index i only.
  float peekBefore(int i, double t) const {
    int last = i - 1;
    if (last >= 0 && ev_[static_cast<std::size_t>(last)].type == Type::Target) {
      Ev tmp = ev_[static_cast<std::size_t>(last)];
      tmp.v0 = targetStart(last);
      return targetValue(tmp, t);
    }
    // Only events before i count: a ramp at i must not shape this value.
    return evalUpTo(last, i, t);
  }

  // What a SetTarget starts from: noted when the cursor reached it, or
  // worked out from the events before it if it's still ahead.
  float targetStart(int i) const {
    return i <= cursor_ ? ev_[static_cast<std::size_t>(i)].v0 : peekBefore(i, ev_[static_cast<std::size_t>(i)].time);
  }

  static float targetValue(const Ev& e, double t) {
    if (e.tau == 0) return e.value;
    return static_cast<float>(e.value + (e.v0 - e.value) * std::exp(-(t - e.time) / e.tau));
  }

  // Value at t when ev_[last] is the latest event at or before t (-1: none)
  // and the next one (if any, and if it's a ramp) is heading somewhere.
  float evalWith(int last, double t) const { return evalUpTo(last, static_cast<int>(ev_.size()), t); }
  float evalUpTo(int last, int limit, double t) const {
    const int next = last + 1;
    if (next < limit && isRamp(ev_[static_cast<std::size_t>(next)].type)) {
      const Ev& r = ev_[static_cast<std::size_t>(next)];
      double t0 = r.t0;
      float v0 = r.v0;
      if (last >= 0) endOf(ev_[static_cast<std::size_t>(last)], t0, v0);
      if (r.time <= t0) return r.value;
      const double f = (t - t0) / (r.time - t0);
      if (r.type == Type::Linear) return static_cast<float>(v0 + (r.value - v0) * f);
      if (v0 == 0.0f || std::signbit(v0) != std::signbit(r.value)) return v0;
      return static_cast<float>(v0 * std::pow(static_cast<double>(r.value) / v0, f));
    }
    if (last < 0) return value_;
    const Ev& e = ev_[static_cast<std::size_t>(last)];
    switch (e.type) {
      case Type::Set:
      case Type::Linear:
      case Type::Exp: return e.value;
      case Type::Target: return targetValue(e, t);
      case Type::Curve: {
        if (t >= e.time + e.duration) return e.value;
        const float* c = curves_.data() + e.curveAt;
        const std::size_t n = static_cast<std::size_t>(e.curveLen);
        const double idx = static_cast<double>(n - 1) / e.duration * (t - e.time);
        const std::size_t k = std::min(static_cast<std::size_t>(idx), n - 1);
        const std::size_t k1 = std::min(k + 1, n - 1);
        const double d = std::min(idx - static_cast<double>(k), 1.0);
        return static_cast<float>(c[k] + (c[k1] - c[k]) * d);
      }
    }
    return value_;
  }

  // Where an event leaves the param (for a ramp that follows it).
  static void endOf(const Ev& e, double& t, float& v) {
    switch (e.type) {
      case Type::Set:
      case Type::Linear:
      case Type::Exp: t = e.time; v = e.value; break;
      case Type::Curve: t = e.time + e.duration; v = e.value; break;
      case Type::Target: t = e.time; v = e.v0; break;  // replaced at insertion; kept for safety
    }
  }

  // Drop curve points no event refers to (only when the pool is full).
  void compactCurves() {
    bool used = false;
    for (const Ev& e : ev_) used |= e.type == Type::Curve;
    if (!used) curves_.clear();
  }

  std::vector<Ev> ev_;
  std::vector<float> curves_;
  int cursor_ = -1;
  double now_ = 0;
  float value_, last_ = 0, min_, max_;
};

}  // namespace sk::wa
