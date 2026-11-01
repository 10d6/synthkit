// Parameters: declared once with ParamBuilder; everything else (UI, patches,
// host automation, mod matrix) is generated from the resulting ParamSpecs.
#pragma once

#include <atomic>
#include <cstdint>
#include <deque>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace sk {

enum class ParamType { Float, Int, Choice, Toggle };
enum class Curve { Linear, Log, Exp };

struct ParamSpec {
  std::string id;
  std::string name;
  std::string unit;
  std::string group;
  ParamType type = ParamType::Float;
  double min = 0, max = 1, def = 0, step = 0;
  Curve curve = Curve::Linear;
  double curveK = 1;  // Exp: value = min + (max-min) * norm^k
  std::vector<std::string> choices;
  bool modulatable = false;
  bool hidden = false;
  bool kit = false;          // added by synthkit, not the synth
  double smoothingMs = -1;   // -1 = default (10 ms float, 0 otherwise)
  // MIDI controllers that move this parameter (API.md §3): CC value 0…127
  // maps across lo…hi (real units; by knob travel, so a log range stays even).
  struct Controller { int cc = 0; double lo = 0, hi = 1; };
  std::vector<Controller> controllers;

  double clamp(double v) const;           // clamp + quantise to step
  double toNorm(double v) const;          // real units -> 0..1 knob travel
  double fromNorm(double n) const;        // 0..1 -> real units (quantised)
  double smoothing() const;               // effective smoothing in ms
  std::string format(double v) const;     // display text, e.g. "2.00 kHz"
  bool parse(std::string_view text, double& out) const;  // inverse of format
};

// Lightweight handle to a parameter; cheap to copy, used on the audio thread.
struct Param {
  int index = -1;
  bool valid() const { return index >= 0; }
  bool operator==(const Param& o) const { return index == o.index; }
};

struct ParamArray {
  int first = -1;
  int count = 0;
  Param operator[](int i) const { return Param{first + i}; }
  int size() const { return count; }
};

class ParamBuilder;

// Fluent definition returned by ParamBuilder::add / addArray. Setters apply to
// every element of an array.
class ParamDef {
 public:
  ParamDef& name(std::string n);
  ParamDef& range(double lo, double hi);
  ParamDef& log();
  ParamDef& exp(double k);
  ParamDef& def(double v);
  ParamDef& unit(std::string u);
  ParamDef& step(double s);
  ParamDef& integer();
  ParamDef& choices(std::vector<std::string> c);
  ParamDef& toggle();
  ParamDef& modulatable(bool m = true);
  ParamDef& smoothing(double ms);
  ParamDef& group(std::string g);
  ParamDef& hidden(bool h = true);
  // A MIDI controller moves this parameter, in the browser and in a DAW
  // alike; the page and the host follow (API.md §3). cc(n) uses the whole
  // range; cc(n, lo, hi) a part of it. Call again for more controllers.
  ParamDef& cc(int number);
  ParamDef& cc(int number, double lo, double hi);

  operator Param() const { return Param{first_}; }
  operator ParamArray() const { return ParamArray{first_, count_}; }

 private:
  friend class ParamBuilder;
  ParamDef(ParamBuilder* b, int first, int count, bool isArray) : b_(b), first_(first), count_(count), isArray_(isArray) {}
  template <typename F> ParamDef& each(F f);
  ParamBuilder* b_;
  int first_, count_;
  bool isArray_;
};

class ParamBuilder {
 public:
  ParamDef add(std::string id);
  // Creates id.0 … id.(n-1). "{i}" and "{note}" in names are filled per element.
  ParamDef addArray(std::string id, int n);

  // Used by the kit for its own parameters (bypasses the reserved-ID check).
  ParamDef addKit(std::string id);

  // A different default for one of the kit's parameters (env1.attack,
  // master, …), applied once the kit has added them. Unknown or non-kit IDs
  // are reported by finish().
  void kitDefault(std::string id, double value);

  std::vector<ParamSpec> finish();  // validates; throws std::invalid_argument
  int count() const { return static_cast<int>(specs_.size()); }

 private:
  friend class ParamDef;
  struct Pending {
    ParamSpec spec;
    bool isArrayElem = false;
    int arrayIndex = 0;
  };
  std::deque<Pending> specs_;
  std::vector<std::pair<std::string, double>> kitDefaults_;
  bool allowReserved_ = false;
};

bool isReservedParamId(std::string_view id);
std::string noteName(int pitchClass);  // 0 -> "C", 1 -> "C#", …

// Thread-safe parameter values in real units. Any thread may set; the audio
// thread reads. Values are clamped and quantised on set.
class ParamStore {
 public:
  explicit ParamStore(std::vector<ParamSpec> specs);

  int size() const { return static_cast<int>(specs_.size()); }
  const ParamSpec& spec(int i) const { return specs_[static_cast<std::size_t>(i)]; }
  const std::vector<ParamSpec>& specs() const { return specs_; }
  int find(std::string_view id) const;  // -1 if missing

  float get(int i) const { return values_[static_cast<std::size_t>(i)].load(std::memory_order_relaxed); }
  void set(int i, double real);
  double getNorm(int i) const { return spec(i).toNorm(get(i)); }
  void setNorm(int i, double norm) { set(i, spec(i).fromNorm(norm)); }
  void resetToDefaults();

  // Increments on every change; adapters poll this to refresh UI/host.
  uint32_t generation() const { return generation_.load(std::memory_order_relaxed); }

 private:
  std::vector<ParamSpec> specs_;
  std::unique_ptr<std::atomic<float>[]> values_;
  std::unordered_map<std::string, int> index_;
  std::atomic<uint32_t> generation_{0};
};

}  // namespace sk
