// Custom modulation sources (API.md §6). Kit sources (envelopes, LFOs,
// shapes, velocity, beat phase, …) exist automatically; a synth adds its own
// here and drives them with setSource().
#pragma once

#include <deque>
#include <string>
#include <vector>

namespace sk {

struct ModSource {
  int index = -1;  // into the synth's custom sources
  bool valid() const { return index >= 0; }
};

// Describes any source (kit or custom), for UIs and the patch format.
struct ModSourceDesc {
  std::string id;
  std::string name;
  bool perVoice = false;
  bool bipolar = false;
};

class ModSourceBuilder;

class ModSourceDef {
 public:
  ModSourceDef& name(std::string n) { d_->name = std::move(n); return *this; }
  ModSourceDef& perVoice(bool v = true) { d_->perVoice = v; return *this; }
  ModSourceDef& unipolar() { d_->bipolar = false; return *this; }   // 0…1 (default)
  ModSourceDef& bipolar() { d_->bipolar = true; return *this; }     // -1…1
  operator ModSource() const { return ModSource{index_}; }

 private:
  friend class ModSourceBuilder;
  ModSourceDef(ModSourceDesc* d, int i) : d_(d), index_(i) {}
  ModSourceDesc* d_;
  int index_;
};

class ModSourceBuilder {
 public:
  ModSourceDef add(std::string id) {
    defs_.push_back(ModSourceDesc{id, id, false, false});
    return ModSourceDef(&defs_.back(), static_cast<int>(defs_.size()) - 1);
  }
  std::vector<ModSourceDesc> take() { return {defs_.begin(), defs_.end()}; }

 private:
  std::deque<ModSourceDesc> defs_;
};

}  // namespace sk
