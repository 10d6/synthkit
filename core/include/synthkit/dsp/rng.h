#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <initializer_list>

namespace sk::dsp {

// Seedable, allocation-free random numbers (xoshiro128+). The only randomness
// synths should use: it's fast, repeatable from a seed, and audio-thread safe.
class Rng {
 public:
  explicit Rng(uint64_t seed = 0x9E3779B97F4A7C15ull) { this->seed(seed); }

  void seed(uint64_t s) {
    // splitmix64 to spread any seed (even 0) over the state.
    for (auto& w : s_) {
      s += 0x9E3779B97F4A7C15ull;
      uint64_t z = s;
      z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
      z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
      w = static_cast<uint32_t>(z ^ (z >> 31));
    }
    if (!(s_[0] | s_[1] | s_[2] | s_[3])) s_[0] = 1;
    haveSpare_ = false;
  }

  uint32_t next() {
    uint32_t r = s_[0] + s_[3];
    uint32_t t = s_[1] << 9;
    s_[2] ^= s_[0]; s_[3] ^= s_[1]; s_[1] ^= s_[2]; s_[0] ^= s_[3];
    s_[2] ^= t;
    s_[3] = (s_[3] << 11) | (s_[3] >> 21);
    return r;
  }

  float uniform() { return static_cast<float>(next() >> 8) * (1.0f / 16777216.0f); }  // [0, 1)
  float uniform(float lo, float hi) { return lo + (hi - lo) * uniform(); }
  float bipolar() { return uniform() * 2.f - 1.f; }                                   // [-1, 1)
  int integer(int lo, int hi) {                                                       // inclusive
    if (hi <= lo) return lo;
    return lo + static_cast<int>(next() % static_cast<uint32_t>(hi - lo + 1));
  }
  bool chance(float p) { return uniform() < p; }

  float normal() {  // mean 0, sd 1
    if (haveSpare_) { haveSpare_ = false; return spare_; }
    float u, v, s;
    do { u = bipolar(); v = bipolar(); s = u * u + v * v; } while (s >= 1.f || s == 0.f);
    float m = std::sqrt(-2.f * std::log(s) / s);
    spare_ = v * m; haveSpare_ = true;
    return u * m;
  }

  // Index chosen with probability proportional to its weight; -1 if all zero.
  int pick(const float* weights, std::size_t n) {
    float total = 0;
    for (std::size_t i = 0; i < n; ++i) total += weights[i] > 0 ? weights[i] : 0;
    if (total <= 0) return -1;
    float r = uniform() * total;
    for (std::size_t i = 0; i < n; ++i) {
      float w = weights[i] > 0 ? weights[i] : 0;
      if (r < w) return static_cast<int>(i);
      r -= w;
    }
    return static_cast<int>(n - 1);
  }
  int pick(std::initializer_list<float> w) { return pick(w.begin(), w.size()); }
  template <std::size_t N> int pick(const float (&w)[N]) { return pick(w, N); }

 private:
  uint32_t s_[4];
  float spare_ = 0;
  bool haveSpare_ = false;
};

// Mix values into a well-distributed 64-bit seed (e.g. note + counter).
inline uint64_t hashSeed(uint64_t a, uint64_t b = 0, uint64_t c = 0) {
  uint64_t h = 0xCBF29CE484222325ull;
  for (uint64_t v : {a, b, c}) {
    h ^= v + 0x9E3779B97F4A7C15ull + (h << 6) + (h >> 2);
    h *= 0x100000001B3ull;
  }
  return h;
}

}  // namespace sk::dsp
