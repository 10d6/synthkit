#include "synthkit/params.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <locale>
#include <sstream>
#include <stdexcept>

#include "synthkit/error.h"
#include <unordered_set>

namespace sk {

namespace {

std::string replaceAll(std::string s, std::string_view from, const std::string& to) {
  std::size_t pos = 0;
  while ((pos = s.find(from, pos)) != std::string::npos) {
    s.replace(pos, from.size(), to);
    pos += to.size();
  }
  return s;
}

std::string fmt(double v, int sig) {
  // Locale-independent, at most `sig` significant digits, no trailing zeros
  // beyond what's useful for a display.
  std::ostringstream o;
  o.imbue(std::locale::classic());
  double a = std::fabs(v);
  int decimals = a >= 100 ? 0 : a >= 10 ? std::max(0, sig - 2) : std::max(0, sig - 1);
  if (a < 1 && a > 0) decimals = sig;
  o.setf(std::ios::fixed);
  o.precision(std::min(decimals, 4));
  o << v;
  std::string s = o.str();
  if (s.find('.') != std::string::npos) {
    while (!s.empty() && s.back() == '0') s.pop_back();
    if (!s.empty() && s.back() == '.') s.pop_back();
  }
  if (s == "-0") s = "0";
  return s;
}

}  // namespace

// ---------------------------------------------------------------- ParamSpec

double ParamSpec::clamp(double v) const {
  if (!std::isfinite(v)) v = def;
  v = std::clamp(v, std::min(min, max), std::max(min, max));
  if (step > 0) v = min + std::round((v - min) / step) * step;
  return std::clamp(v, std::min(min, max), std::max(min, max));
}

double ParamSpec::toNorm(double v) const {
  if (max == min) return 0;
  v = clamp(v);
  double n;
  switch (curve) {
    case Curve::Log: n = std::log(v / min) / std::log(max / min); break;
    case Curve::Exp: n = std::pow((v - min) / (max - min), 1.0 / curveK); break;
    default: n = (v - min) / (max - min);
  }
  return std::clamp(n, 0.0, 1.0);
}

double ParamSpec::fromNorm(double n) const {
  n = std::clamp(std::isfinite(n) ? n : 0.0, 0.0, 1.0);
  double v;
  switch (curve) {
    case Curve::Log: v = min * std::pow(max / min, n); break;
    case Curve::Exp: v = min + (max - min) * std::pow(n, curveK); break;
    default: v = min + (max - min) * n;
  }
  return clamp(v);
}

double ParamSpec::smoothing() const {
  if (smoothingMs >= 0) return smoothingMs;
  return type == ParamType::Float ? 10.0 : 0.0;
}

std::string ParamSpec::format(double v) const {
  v = clamp(v);
  if (type == ParamType::Toggle) return v >= 0.5 ? "On" : "Off";
  if (type == ParamType::Choice) {
    auto i = static_cast<std::size_t>(std::lround(v));
    return i < choices.size() ? choices[i] : std::to_string(i);
  }
  if (unit == "Hz" && std::fabs(v) >= 1000) return fmt(v / 1000, 3) + " kHz";
  if (unit == "s" && std::fabs(v) < 1) return fmt(v * 1000, 3) + " ms";
  std::string num = type == ParamType::Int || step >= 1 ? std::to_string(std::lround(v)) : fmt(v, 3);
  return unit.empty() ? num : num + " " + unit;
}

bool ParamSpec::parse(std::string_view text, double& out) const {
  std::string t(text);
  if (type == ParamType::Toggle) {
    std::string l;
    for (char c : t) l += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (l == "on" || l == "1" || l == "true") { out = 1; return true; }
    if (l == "off" || l == "0" || l == "false") { out = 0; return true; }
    return false;
  }
  if (type == ParamType::Choice) {
    for (std::size_t i = 0; i < choices.size(); ++i)
      if (choices[i] == t) { out = static_cast<double>(i); return true; }
  }
  std::istringstream in(t);
  in.imbue(std::locale::classic());
  double v;
  if (!(in >> v)) return false;
  std::string suffix;
  in >> suffix;
  if (suffix == "kHz" || suffix == "k") v *= 1000;
  else if (suffix == "ms") v /= 1000;
  out = clamp(v);
  return true;
}

// ---------------------------------------------------------------- ParamDef

template <typename F>
ParamDef& ParamDef::each(F f) {
  for (int i = 0; i < count_; ++i) f(b_->specs_[static_cast<std::size_t>(first_ + i)].spec);
  return *this;
}

ParamDef& ParamDef::name(std::string n) {
  int k = 0;
  return each([&](ParamSpec& s) {
    std::string out = n;
    if (isArray_) {
      out = replaceAll(out, "{i}", std::to_string(k));
      out = replaceAll(out, "{note}", noteName(k % 12));
      if (out == n) out = n + " " + std::to_string(k + 1);
    }
    s.name = out;
    ++k;
  });
}
ParamDef& ParamDef::range(double lo, double hi) {
  return each([&](ParamSpec& s) {
    s.min = lo; s.max = hi;
    if (s.def < lo || s.def > hi) s.def = lo;
  });
}
ParamDef& ParamDef::log() { return each([](ParamSpec& s) { s.curve = Curve::Log; }); }
ParamDef& ParamDef::exp(double k) { return each([&](ParamSpec& s) { s.curve = Curve::Exp; s.curveK = k; }); }
ParamDef& ParamDef::def(double v) { return each([&](ParamSpec& s) { s.def = v; }); }
ParamDef& ParamDef::unit(std::string u) { return each([&](ParamSpec& s) { s.unit = u; }); }
ParamDef& ParamDef::step(double st) { return each([&](ParamSpec& s) { s.step = st; }); }
ParamDef& ParamDef::integer() { return each([](ParamSpec& s) { s.type = ParamType::Int; s.step = 1; }); }
ParamDef& ParamDef::choices(std::vector<std::string> c) {
  return each([&](ParamSpec& s) {
    s.type = ParamType::Choice;
    s.choices = c;
    s.min = 0; s.max = static_cast<double>(c.empty() ? 0 : c.size() - 1); s.step = 1;
    if (s.def > s.max) s.def = 0;
  });
}
ParamDef& ParamDef::toggle() {
  return each([](ParamSpec& s) { s.type = ParamType::Toggle; s.min = 0; s.max = 1; s.step = 1; });
}
ParamDef& ParamDef::modulatable(bool m) { return each([&](ParamSpec& s) { s.modulatable = m; }); }
ParamDef& ParamDef::smoothing(double ms) { return each([&](ParamSpec& s) { s.smoothingMs = ms; }); }
ParamDef& ParamDef::group(std::string g) { return each([&](ParamSpec& s) { s.group = g; }); }
ParamDef& ParamDef::hidden(bool h) { return each([&](ParamSpec& s) { s.hidden = h; }); }

// ---------------------------------------------------------------- ParamBuilder

bool isReservedParamId(std::string_view id) {
  static const std::unordered_set<std::string_view> exact = {
      "master", "voiceMode", "glide", "bendRange", "unison", "unisonDetune", "unisonSpread"};
  if (exact.count(id)) return true;
  if (id.substr(0, 3) == "sk.") return true;
  for (std::string_view p : {std::string_view("env"), std::string_view("lfo"), std::string_view("shape")}) {
    if (id.substr(0, p.size()) != p) continue;
    std::size_t k = p.size();
    if (k < id.size() && std::isdigit(static_cast<unsigned char>(id[k]))) {
      while (k < id.size() && std::isdigit(static_cast<unsigned char>(id[k]))) ++k;
      if (k == id.size() || id[k] == '.') return true;
    }
  }
  return false;
}

std::string noteName(int pc) {
  static const char* n[] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
  return n[((pc % 12) + 12) % 12];
}

ParamDef ParamBuilder::add(std::string id) {
  if (!allowReserved_ && isReservedParamId(id))
    fail("parameter id '" + id + "' is reserved by synthkit");
  Pending p;
  p.spec.id = std::move(id);
  p.spec.name = p.spec.id;
  specs_.push_back(std::move(p));
  int idx = count() - 1;
  return ParamDef(this, idx, 1, false);
}

ParamDef ParamBuilder::addKit(std::string id) {
  allowReserved_ = true;
  ParamDef d = add(std::move(id));
  allowReserved_ = false;
  specs_.back().spec.kit = true;
  return d;
}

ParamDef ParamBuilder::addArray(std::string id, int n) {
  if (n <= 0) fail("parameter array '" + id + "' needs at least one element");
  int first = count();
  for (int i = 0; i < n; ++i) {
    std::string eid = id + "." + std::to_string(i);
    if (isReservedParamId(eid)) fail("parameter id '" + eid + "' is reserved by synthkit");
    Pending p;
    p.spec.id = eid;
    p.spec.name = id + " " + std::to_string(i + 1);
    p.isArrayElem = true;
    p.arrayIndex = i;
    specs_.push_back(std::move(p));
  }
  return ParamDef(this, first, n, true);
}

std::vector<ParamSpec> ParamBuilder::finish() {
  std::vector<ParamSpec> out;
  std::unordered_set<std::string> seen;
  for (auto& p : specs_) {
    ParamSpec s = p.spec;
    if (s.id.empty()) fail("parameter with empty id");
    if (!seen.insert(s.id).second) fail("duplicate parameter id '" + s.id + "'");
    if (s.curve == Curve::Log && (s.min <= 0 || s.max <= 0))
      fail("parameter '" + s.id + "': log() needs a positive range");
    if (s.max < s.min) fail("parameter '" + s.id + "': range max < min");
    s.def = s.clamp(s.def);
    out.push_back(std::move(s));
  }
  return out;
}

// ---------------------------------------------------------------- ParamStore

ParamStore::ParamStore(std::vector<ParamSpec> specs)
    : specs_(std::move(specs)), values_(new std::atomic<float>[specs_.size()]) {
  for (std::size_t i = 0; i < specs_.size(); ++i) {
    index_[specs_[i].id] = static_cast<int>(i);
    values_[i].store(static_cast<float>(specs_[i].def), std::memory_order_relaxed);
  }
}

int ParamStore::find(std::string_view id) const {
  auto it = index_.find(std::string(id));
  return it == index_.end() ? -1 : it->second;
}

void ParamStore::set(int i, double real) {
  if (i < 0 || i >= size()) return;
  float v = static_cast<float>(spec(i).clamp(real));
  if (values_[static_cast<std::size_t>(i)].exchange(v, std::memory_order_relaxed) != v)
    generation_.fetch_add(1, std::memory_order_relaxed);
}

void ParamStore::resetToDefaults() {
  for (int i = 0; i < size(); ++i) set(i, spec(i).def);
}

}  // namespace sk
