#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "synthkit/json.h"

namespace sk {

// A patch as JSON, with helpers for migratePatch.
class PatchData {
 public:
  explicit PatchData(Json& j) : j_(j) {}
  Json& json() { return j_; }

  bool hasParam(std::string_view id) const { return j_["params"].contains(id); }
  double param(std::string_view id, double fallback = 0) const { return j_["params"][id].number(fallback); }
  void setParam(std::string_view id, double v) { j_["params"][id] = v; }
  void removeParam(std::string_view id) { if (j_["params"].isObject()) j_["params"].erase(id); }
  void renameParam(std::string_view from, std::string_view to) {
    if (!hasParam(from)) return;
    double v = param(from);
    removeParam(from);
    setParam(to, v);
  }
  Json& custom(std::string_view id) { return j_["custom"][id]; }

 private:
  Json& j_;
};

struct PatchMeta {
  std::string name = "Init";
  std::string author;
  std::vector<std::string> tags;
};

struct LoadResult {
  bool ok = true;
  std::string error;                  // set when ok == false
  std::vector<std::string> warnings;  // unknown params, newer version, …
};

}  // namespace sk
