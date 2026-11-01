#include "modulation.h"

#include <algorithm>
#include <cmath>

#include "synthkit/engine.h"
#include "synthkit/error.h"

namespace sk::detail {

namespace {

float frac(double x) { return static_cast<float>(x - std::floor(x)); }

// Divisions in quarter-note beats; negative values are bars.
struct Div { const char* name; double beats; };
const Div kLfoDivs[] = {
    {"8 bars", -8}, {"4 bars", -4}, {"2 bars", -2}, {"1 bar", -1}, {"1/2", 2}, {"1/4.", 1.5}, {"1/4", 1},
    {"1/4T", 2.0 / 3}, {"1/8.", 0.75}, {"1/8", 0.5}, {"1/8T", 1.0 / 3}, {"1/16", 0.25}, {"1/16T", 1.0 / 6}, {"1/32", 0.125}};
const Div kShapeLens[] = {
    {"16 bars", -16}, {"8 bars", -8}, {"4 bars", -4}, {"2 bars", -2}, {"1 bar", -1}, {"1/2", 2}, {"1/4.", 1.5},
    {"1/4", 1}, {"1/4T", 2.0 / 3}, {"1/8", 0.5}, {"1/8T", 1.0 / 3}, {"1/16", 0.25}};
constexpr int kLfoDivDefault = 6;     // 1/4
constexpr int kShapeLenDefault = 4;   // 1 bar

double divBeats(const Div& d, const Transport& t) { return d.beats < 0 ? -d.beats * t.beatsPerBar() : d.beats; }

template <std::size_t N>
std::vector<std::string> names(const Div (&d)[N]) {
  std::vector<std::string> v;
  for (auto& x : d) v.push_back(x.name);
  return v;
}

int choiceAt(const float* values, int p) { return static_cast<int>(values[p] + 0.5f); }

enum LfoMode { LfoGlobal = 0, LfoVoice = 1 };
enum Trigger { TrNote = 0, TrFirst = 1, TrBar = 2, TrBeat = 3, TrFree = 4, TrManual = 5 };
enum Loop { LoOnce = 0, LoLoop = 1, LoHeld = 2, LoPing = 3, LoRelease = 4 };

}  // namespace

const std::vector<std::string>& lfoDivisionNames() { static const auto v = names(kLfoDivs); return v; }
const std::vector<std::string>& shapeLengthNames() { static const auto v = names(kShapeLens); return v; }

// ---------------------------------------------------------------- curves

float ShapeCurve::eval(float x) const {
  if (pts.empty()) return 0;
  if (x <= pts.front().x) return pts.front().y;
  if (x >= pts.back().x) return pts.back().y;
  std::size_t i = 0;
  while (i + 1 < pts.size() && pts[i + 1].x < x) ++i;
  const auto& a = pts[i];
  const auto& b = pts[i + 1];
  if (a.hold) return a.y;
  float w = b.x - a.x;
  if (w <= 1e-6f) return b.y;
  if (a.handles || b.handles) {
    // Cubic Bezier. Handle reach is limited to half the segment each way, so
    // x(t) always increases and the curve can't bend back in time.
    float c1x = a.x + std::clamp(a.handles ? a.ox : 0.f, 0.f, 0.5f * w);
    float c2x = b.x + std::clamp(b.handles ? b.ix : 0.f, -0.5f * w, 0.f);
    float c1y = a.y + (a.handles ? a.oy : 0.f);
    float c2y = b.y + (b.handles ? b.iy : 0.f);
    auto bez = [](float p0, float p1, float p2, float p3, float t) {
      float u = 1 - t;
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    };
    float lo = 0, hi = 1, t = (x - a.x) / w;
    for (int k = 0; k < 24; ++k) {  // x(t) is monotonic: bisection always converges
      float xt = bez(a.x, c1x, c2x, b.x, t);
      if (std::fabs(xt - x) < 1e-6f) break;
      if (xt < x) lo = t; else hi = t;
      t = 0.5f * (lo + hi);
    }
    return std::clamp(bez(a.y, c1y, c2y, b.y, t), 0.f, 1.f);
  }
  float t = (x - a.x) / w;
  if (a.c != 0) t = std::pow(t, std::exp2(3.f * a.c));
  return a.y + (b.y - a.y) * t;
}

ShapeCurve Modulation::defaultCurve() {
  ShapeCurve c;
  c.pts = {{0.f, 1.f, -0.5f, false}, {1.f, 0.f, 0.f, false}};
  return c;
}

// ---------------------------------------------------------------- setup

void Modulation::addKitParams(ParamBuilder& b, const SynthInfo& info) {
  const auto& f = info.features;
  modSlots_ = f.modSlots;
  if (modSlots_ > 0) {
    pPitch_ = b.count(); b.addKit("sk.pitch").name("Pitch Offset").range(-12, 12).def(0).unit("st").modulatable().group("Modulation");
    pLevel_ = b.count(); b.addKit("sk.level").name("Voice Level").range(0, 1).def(1).modulatable().group("Modulation");
    pAgeSpan_ = b.count(); b.addKit("sk.ageSpan").name("Note Age Span").range(1, 32).integer().def(4).unit("beats").group("Modulation");
  }
  if (f.userLfos)
    pLfos_ = b.count(), b.addKit("sk.lfos").name("LFOs in Use").range(0, f.standardLfos).integer().def(f.lfosStart).hidden().group("Modulation");
  for (int n = 1; n <= f.standardLfos; ++n) {
    std::string p = "lfo" + std::to_string(n) + ".", nm = "LFO " + std::to_string(n) + " ", g = "LFO " + std::to_string(n);
    LfoP l{};
    l.shape = b.count(); b.addKit(p + "shape").name(nm + "Shape").choices({"Sine", "Triangle", "Saw Up", "Saw Down", "Square", "S&H", "Drift"}).group(g);
    l.rate = b.count(); b.addKit(p + "rate").name(nm + "Rate").range(0.01, 40).log().def(2).unit("Hz").modulatable().group(g);
    l.sync = b.count(); b.addKit(p + "sync").name(nm + "Sync").toggle().def(0).group(g);
    l.division = b.count(); b.addKit(p + "division").name(nm + "Division").choices(lfoDivisionNames()).def(kLfoDivDefault).group(g);
    l.mode = b.count(); b.addKit(p + "mode").name(nm + "Mode").choices({"Global", "Per Voice"}).group(g);
    l.phase = b.count(); b.addKit(p + "phase").name(nm + "Phase").range(0, 1).def(0).modulatable().group(g);
    l.depth = b.count(); b.addKit(p + "depth").name(nm + "Depth").range(0, 1).def(1).modulatable().group(g);
    l.fade = b.count(); b.addKit(p + "fade").name(nm + "Fade In").range(0, 10).exp(3).def(0).unit("s").group(g);
    lfoP_.push_back(l);
  }
  for (int n = 1; n <= f.shapes; ++n) {
    std::string p = "shape" + std::to_string(n) + ".", nm = "Shape " + std::to_string(n) + " ", g = "Shape " + std::to_string(n);
    ShapeP s{};
    s.length = b.count(); b.addKit(p + "length").name(nm + "Length").choices(shapeLengthNames()).def(kShapeLenDefault).group(g);
    s.sync = b.count(); b.addKit(p + "sync").name(nm + "Sync").toggle().def(1).group(g);
    s.time = b.count(); b.addKit(p + "time").name(nm + "Time").range(0.01, 30).log().def(1).unit("s").group(g);
    s.trigger = b.count(); b.addKit(p + "trigger").name(nm + "Trigger").choices({"Note", "First Note", "Bar", "Beat", "Free", "Manual"}).group(g);
    s.start = b.count(); b.addKit(p + "start").name(nm + "Start").choices({"Immediately", "Next 1/16", "Next 1/8", "Next 1/4", "Next Bar"}).group(g);
    s.loop = b.count(); b.addKit(p + "loop").name(nm + "Loop").choices({"Once", "Loop", "While Held", "Ping-Pong", "Release"}).group(g);
    s.rate = b.count(); b.addKit(p + "rate").name(nm + "Rate").range(0.25, 4).log().def(1).unit("x").modulatable().group(g);
    s.offset = b.count(); b.addKit(p + "offset").name(nm + "Offset").range(0, 1).def(0).modulatable().group(g);
    s.depth = b.count(); b.addKit(p + "depth").name(nm + "Depth").range(0, 1).def(1).modulatable().group(g);
    s.smooth = b.count(); b.addKit(p + "smooth").name(nm + "Smooth").range(0, 1).def(0).group(g);
    s.keyLo = b.count(); b.addKit(p + "keyLow").name(nm + "Lowest Key").range(0, 127).integer().def(0).group(g);
    s.keyHi = b.count(); b.addKit(p + "keyHigh").name(nm + "Highest Key").range(0, 127).integer().def(127).group(g);
    s.velLo = b.count(); b.addKit(p + "velLow").name(nm + "Lowest Velocity").range(1, 127).integer().def(1).group(g);
    s.velHi = b.count(); b.addKit(p + "velHigh").name(nm + "Highest Velocity").range(1, 127).integer().def(127).group(g);
    s.curve = b.count(); b.addKit(p + "curve").name(nm + "Curve").range(1, kMaxCurves).integer().def(1).group(g);
    shapeP_.push_back(s);
  }
}

void Modulation::init(const ParamStore& store, const SynthInfo& info, std::vector<ModSourceDesc> custom, AudioEpoch* epoch) {
  store_ = &store;
  nEnv_ = info.features.standardEnvelopes;
  nLfo_ = static_cast<int>(lfoP_.size());
  nShape_ = static_cast<int>(shapeP_.size());
  nCustom_ = static_cast<int>(custom.size());
  enabled_ = modSlots_ > 0 || nLfo_ > 0 || nShape_ > 0 || nCustom_ > 0;

  auto add = [&](std::string id, std::string name, Src k, int idx, bool pv, bool bi) {
    sources_.push_back(SourceInfo{ModSourceDesc{std::move(id), std::move(name), pv, bi}, k, idx});
    return static_cast<int>(sources_.size()) - 1;
  };
  for (int e = 0; e < nEnv_; ++e) add("env" + std::to_string(e + 1), "Envelope " + std::to_string(e + 1), Src::Env, e, true, false);
  firstLfo_ = static_cast<int>(sources_.size());
  for (int l = 0; l < nLfo_; ++l) add("lfo" + std::to_string(l + 1), "LFO " + std::to_string(l + 1), Src::Lfo, l, false, true);
  firstShape_ = static_cast<int>(sources_.size());
  for (int s = 0; s < nShape_; ++s) add("shape" + std::to_string(s + 1), "Shape " + std::to_string(s + 1), Src::Shape, s, false, false);
  iVel_ = add("velocity", "Velocity", Src::Velocity, 0, true, false);
  iKey_ = add("key", "Key", Src::Key, 0, true, true);
  iRandom_ = add("random", "Random", Src::Random, 0, true, true);
  iAT_ = add("aftertouch", "Aftertouch", Src::Aftertouch, 0, true, false);
  iMW_ = add("modwheel", "Mod Wheel", Src::ModWheel, 0, false, false);
  iBend_ = add("bend", "Pitch Bend", Src::Bend, 0, false, true);
  iConst_ = add("const", "Constant", Src::Const, 0, false, false);
  iBeat_ = add("beat.phase", "Beat Phase", Src::BeatPhase, 0, false, false);
  iBar_ = add("bar.phase", "Bar Phase", Src::BarPhase, 0, false, false);
  iBarBeat_ = add("bar.beat", "Beat in Bar", Src::BarBeat, 0, false, false);
  iDown_ = add("downbeat", "Downbeat", Src::Downbeat, 0, false, false);
  iAge_ = add("note.age", "Note Age", Src::NoteAge, 0, true, false);
  iOff_ = add("note.offbeat", "Off-Beat", Src::NoteOffbeat, 0, true, true);
  firstCustom_ = static_cast<int>(sources_.size());
  for (int c = 0; c < nCustom_; ++c) {
    auto& d = custom[static_cast<std::size_t>(c)];
    if (findSource(d.id) >= 0) fail("mod source id '" + d.id + "' is already used by a kit source");
    add(d.id, d.name, Src::Custom, c, d.perVoice, d.bipolar);
  }

  matrix_ = std::make_unique<CustomSlot<Matrix>>("sk.mod", CustomIO<Matrix>{}, epoch);
  ShapeBank bank;
  bank.shapes.assign(static_cast<std::size_t>(nShape_), std::vector<ShapeCurve>{defaultCurve()});
  bank_ = std::make_unique<CustomSlot<ShapeBank>>("sk.shapes", CustomIO<ShapeBank>{{}, {}, bank}, epoch);
}

int Modulation::findSource(const std::string& id) const {
  for (std::size_t i = 0; i < sources_.size(); ++i)
    if (sources_[i].desc.id == id) return static_cast<int>(i);
  return -1;
}

void Modulation::prepare(double sampleRate, int nParams, const float* values) {
  sr_ = sampleRate;
  curValues_ = values;  // notes can arrive before the first block's beginBlock
  auto ns = sources_.size();
  gsrc_.assign(ns, 0.f);
  srcVoice_.assign(ns, 0);
  gvals_.assign(static_cast<std::size_t>(nParams), 0.f);
  gprev_.assign(static_cast<std::size_t>(nParams), 0.f);
  for (int i = 0; i < nParams; ++i) gvals_[static_cast<std::size_t>(i)] = gprev_[static_cast<std::size_t>(i)] = store_->get(i);
  glfo_.assign(static_cast<std::size_t>(nLfo_), {});
  gshape_.assign(static_cast<std::size_t>(nShape_), {});
  gcustom_.assign(static_cast<std::size_t>(nCustom_), 0.f);
  off_.assign(static_cast<std::size_t>(nParams), 0.f);
  isTouched_.assign(static_cast<std::size_t>(nParams), 0);
  modulated_.assign(static_cast<std::size_t>(nParams), 0);
  touched_.clear();
  touched_.reserve(static_cast<std::size_t>(nParams));
  for (auto& s : snap_) {
    s.src.assign(ns, 0.f);
    s.params.assign(static_cast<std::size_t>(nParams), NAN);
    s.shapes.assign(static_cast<std::size_t>(nShape_) * 2, 0.f);
  }
}

void Modulation::prepareVoice(ModVoice& v) const {
  v.lfo.assign(static_cast<std::size_t>(nLfo_), {});
  v.shape.assign(static_cast<std::size_t>(nShape_), {});
  v.custom.assign(static_cast<std::size_t>(nCustom_), NAN);
  v.src.assign(sources_.size(), 0.f);
  v.vals.assign(gvals_.size(), 0.f);
  v.prevVals.assign(gvals_.size(), 0.f);
}

// ---------------------------------------------------------------- LFOs

float Modulation::lfoValue(LfoRun& r, int shape, double phase, dsp::Rng& rng) {
  float p = frac(phase);
  if (r.lastPhase < 0) { r.held = rng.bipolar(); r.next = rng.bipolar(); }
  else if (p < r.lastPhase - 1e-6) { r.held = r.next; r.next = rng.bipolar(); }  // wrapped
  r.lastPhase = p;
  switch (shape) {
    case 0: return std::sin(6.2831853f * p);
    case 1: { float q = frac(p + 0.25); return 1.f - 4.f * std::fabs(q - 0.5f); }  // starts at 0, rising
    case 2: return 2.f * p - 1.f;
    case 3: return 1.f - 2.f * p;
    case 4: return p < 0.5f ? 1.f : -1.f;
    case 5: return r.held;
    case 6: { float w = 0.5f - 0.5f * std::cos(3.14159265f * p); return r.held + (r.next - r.held) * w; }
  }
  return 0;
}

// ---------------------------------------------------------------- shapes

double Modulation::shapeLengthBeats(int s, const float* values, const Transport& t) const {
  int i = std::clamp(choiceAt(values, shapeP_[static_cast<std::size_t>(s)].length), 0, static_cast<int>(std::size(kShapeLens)) - 1);
  return divBeats(kShapeLens[i], t);
}

void Modulation::startShape(ShapeRun& r, int s, const float* values, const Transport& t, int note, float vel) {
  const auto& P = shapeP_[static_cast<std::size_t>(s)];
  int v127 = static_cast<int>(std::lround(vel * 127.f));
  r.active = note >= values[P.keyLo] - 0.5f && note <= values[P.keyHi] + 0.5f &&
             v127 >= values[P.velLo] - 0.5f && v127 <= values[P.velHi] + 0.5f;
  r.started = false;
  r.released = false;
  r.pos = 0;
  static const Division starts[] = {Division(0), Division::Sixteenth, Division::Eighth, Division::Quarter, Division::Bar};
  int st = std::clamp(choiceAt(values, P.start), 0, 4);
  r.startAt = st == 0 ? t.beat : quantizeUp(t.beat, starts[st], t);
}

void Modulation::computeShape(ShapeRun& r, int s, const float* values, const Transport& t, int len) {
  const auto& P = shapeP_[static_cast<std::size_t>(s)];
  int trig = choiceAt(values, P.trigger);
  int loop = choiceAt(values, P.loop);
  bool sync = values[P.sync] >= 0.5f;
  double rate = values[P.rate];
  double lenBeats = shapeLengthBeats(s, values, t);
  double lenSec = std::max(0.001f, values[P.time]);
  double spbSec = 60.0 / t.bpm;
  double dtSec = len / sr_;
  const auto& bank = bank_->read();
  int ci = std::clamp(static_cast<int>(values[P.curve] + 0.5f) - 1, 0, kMaxCurves - 1);
  const auto& curves = bank.shapes[static_cast<std::size_t>(s)];
  const ShapeCurve& curve = curves[static_cast<std::size_t>(std::min<int>(ci, static_cast<int>(curves.size()) - 1))];
  float off = values[P.offset];

  double pos;
  bool transportLocked = trig == TrBar || trig == TrBeat || trig == TrFree;
  if (transportLocked) {
    double since;
    if (trig == TrBar) since = t.beat - t.barStart;
    else if (trig == TrBeat) since = std::fmod(t.beat - t.barStart, 4.0 / t.timeSigDen);
    else since = t.beat;
    pos = (sync ? since / lenBeats : since * spbSec / lenSec) * rate;
    r.active = r.started = true;
    if (trig == TrFree) loop = loop == LoPing ? LoPing : LoLoop;
  } else {
    if (!r.active) { r.value = 0; r.out = 0; r.phase = 0; return; }
    if (!r.started && t.beat >= r.startAt - 1e-9) { r.started = true; r.pos = 0; }
    if (r.started) r.pos += (sync ? dtSec / spbSec / lenBeats : dtSec / lenSec) * rate;
    pos = r.pos;
  }

  double ph = 0;
  if (r.started) {
    switch (loop) {
      case LoOnce: ph = std::min(pos, 1.0); break;
      case LoLoop: ph = frac(pos); break;
      case LoHeld: ph = r.released ? std::min(r.relPhase + (pos - r.relPos), 1.0) : frac(pos); break;
      case LoPing: { double k = std::floor(pos), f = pos - k; ph = (static_cast<long long>(k) & 1) ? 1 - f : f; break; }
      case LoRelease: {
        double R = curve.release >= 0 ? curve.release : 1.0;
        ph = r.released ? std::min(R + (pos - r.relPos), 1.0) : std::min(pos, R);
        break;
      }
    }
    if (!r.released) r.relPhase = ph;
  }
  bool wraps = loop == LoLoop || loop == LoPing;
  double phOff = wraps ? frac(ph + off) : std::min(ph + off, 1.0);
  r.phase = static_cast<float>(phOff);
  r.value = curve.eval(r.phase) * values[P.depth];
  float sm = values[P.smooth];
  if (sm <= 0.001f) r.out = r.value;
  else r.out = r.value + (r.out - r.value) * std::exp(static_cast<float>(-dtSec) / (sm * 0.25f));
}

// ---------------------------------------------------------------- per block

void Modulation::applyRoutes(const float* src, const float* values, float* out, bool) const {
  const auto& m = matrix_->read();
  auto& off = const_cast<std::vector<float>&>(off_);
  auto& touched = const_cast<std::vector<int>&>(touched_);
  auto& is = const_cast<std::vector<char>&>(isTouched_);
  for (const auto& r : m.routes) {
    float v = src[r.src] * r.amt;
    if (r.via >= 0) v *= src[r.via];
    if (!is[static_cast<std::size_t>(r.dst)]) { is[static_cast<std::size_t>(r.dst)] = 1; touched.push_back(r.dst); off[static_cast<std::size_t>(r.dst)] = 0; }
    off[static_cast<std::size_t>(r.dst)] += v;
  }
  for (int d : touched) {
    const auto& sp = store_->spec(d);
    double n = sp.toNorm(values[d]) + off[static_cast<std::size_t>(d)];
    out[d] = static_cast<float>(sp.fromNorm(std::clamp(n, 0.0, 1.0)));
    is[static_cast<std::size_t>(d)] = 0;
  }
  touched.clear();
}

void Modulation::beginBlock(const float* values, const Transport& t, double, int len, float modwheel, float bend, float aftertouch) {
  curValues_ = values;
  double dt = len / sr_;
  int inUse = pLfos_ >= 0 ? std::clamp(static_cast<int>(std::lround(values[pLfos_])), 0, nLfo_) : nLfo_;
  for (int l = 0; l < nLfo_; ++l) {
    const auto& P = lfoP_[static_cast<std::size_t>(l)];
    auto& r = glfo_[static_cast<std::size_t>(l)];
    int idx = firstLfo_ + l;
    if (l >= inUse) {
      // Not in use: silent, and starts afresh when it's added.
      srcVoice_[static_cast<std::size_t>(idx)] = 0;
      gsrc_[static_cast<std::size_t>(idx)] = 0;
      r = LfoRun{};
      continue;
    }
    bool perVoice = choiceAt(values, P.mode) == LfoVoice;
    srcVoice_[static_cast<std::size_t>(idx)] = perVoice || values[P.fade] > 0.0005f;
    if (perVoice) { gsrc_[static_cast<std::size_t>(idx)] = 0; continue; }
    double phase;
    if (values[P.sync] >= 0.5f) {
      int di = std::clamp(choiceAt(values, P.division), 0, static_cast<int>(std::size(kLfoDivs)) - 1);
      phase = t.beat / divBeats(kLfoDivs[di], t);
    } else {
      r.phase = r.phase + values[P.rate] * dt;
      r.phase -= std::floor(r.phase);
      phase = r.phase;
    }
    gsrc_[static_cast<std::size_t>(idx)] = lfoValue(r, choiceAt(values, P.shape), phase + values[P.phase], grng_) * values[P.depth];
  }
  for (int s = 0; s < nShape_; ++s) {
    int idx = firstShape_ + s;
    bool perVoice = choiceAt(values, shapeP_[static_cast<std::size_t>(s)].trigger) == TrNote;
    srcVoice_[static_cast<std::size_t>(idx)] = perVoice;
    if (perVoice) { gsrc_[static_cast<std::size_t>(idx)] = 0; continue; }
    computeShape(gshape_[static_cast<std::size_t>(s)], s, values, t, len);
    gsrc_[static_cast<std::size_t>(idx)] = gshape_[static_cast<std::size_t>(s)].out;
  }
  for (int e = 0; e < nEnv_; ++e) { gsrc_[static_cast<std::size_t>(e)] = 0; srcVoice_[static_cast<std::size_t>(e)] = 1; }
  double inBar = t.beat - t.barStart;
  double unit = 4.0 / t.timeSigDen;
  auto set = [&](int i, float v, bool pv) { gsrc_[static_cast<std::size_t>(i)] = v; srcVoice_[static_cast<std::size_t>(i)] = pv; };
  set(iVel_, 0, true);
  set(iKey_, 0, true);
  set(iRandom_, 0, true);
  set(iAT_, aftertouch, true);
  set(iMW_, modwheel, false);
  set(iBend_, bend, false);
  set(iConst_, 1, false);
  set(iBeat_, frac(t.beat), false);
  set(iBar_, static_cast<float>(std::clamp(inBar / t.beatsPerBar(), 0.0, 1.0)), false);
  set(iBarBeat_, static_cast<float>(std::floor(inBar / unit + 1e-9) / std::max(1, t.timeSigNum)), false);
  set(iDown_, inBar < unit ? 1.f : 0.f, false);
  set(iAge_, 0, true);
  set(iOff_, 0, true);
  for (int c = 0; c < nCustom_; ++c) set(firstCustom_ + c, gcustom_[static_cast<std::size_t>(c)], sources_[static_cast<std::size_t>(firstCustom_ + c)].desc.perVoice);

  std::copy(gvals_.begin(), gvals_.end(), gprev_.begin());
  std::copy(values, values + gvals_.size(), gvals_.begin());
  applyRoutes(gsrc_.data(), values, gvals_.data(), true);
}

void Modulation::voiceBlock(ModVoice& v, const VoiceIn& in, const float* values, const Transport& t, int len) {
  double dt = len / sr_;
  v.age += dt;
  std::copy(gsrc_.begin(), gsrc_.end(), v.src.begin());
  for (int e = 0; e < std::min(nEnv_, in.nEnv); ++e) v.src[static_cast<std::size_t>(e)] = in.env[e];
  for (int l = 0; l < nLfo_; ++l) {
    const auto& P = lfoP_[static_cast<std::size_t>(l)];
    int idx = firstLfo_ + l;
    if (!srcVoice_[static_cast<std::size_t>(idx)]) continue;
    float fadeT = values[P.fade];
    float fade = fadeT > 0.0005f ? static_cast<float>(std::min(1.0, v.age / fadeT)) : 1.f;
    if (choiceAt(values, P.mode) == LfoVoice) {
      auto& r = v.lfo[static_cast<std::size_t>(l)];
      double phase;
      if (values[P.sync] >= 0.5f) {
        int di = std::clamp(choiceAt(values, P.division), 0, static_cast<int>(std::size(kLfoDivs)) - 1);
        phase = (t.beat - v.startBeat) / divBeats(kLfoDivs[di], t);
      } else {
        r.phase += values[P.rate] * dt;
        phase = r.phase;
      }
      v.src[static_cast<std::size_t>(idx)] = lfoValue(r, choiceAt(values, P.shape), phase + values[P.phase], v.rng) * values[P.depth] * fade;
    } else {
      v.src[static_cast<std::size_t>(idx)] = gsrc_[static_cast<std::size_t>(idx)] * fade;
    }
  }
  for (int s = 0; s < nShape_; ++s) {
    int idx = firstShape_ + s;
    if (!srcVoice_[static_cast<std::size_t>(idx)]) continue;
    auto& r = v.shape[static_cast<std::size_t>(s)];
    computeShape(r, s, values, t, len);
    v.src[static_cast<std::size_t>(idx)] = r.out;
  }
  v.src[static_cast<std::size_t>(iVel_)] = in.vel;
  v.src[static_cast<std::size_t>(iKey_)] = std::clamp((in.note - 60) / 60.f, -1.f, 1.f);
  v.src[static_cast<std::size_t>(iRandom_)] = v.random;
  v.src[static_cast<std::size_t>(iAT_)] = in.aftertouch;
  double span = pAgeSpan_ >= 0 ? values[pAgeSpan_] : 4.0;
  v.src[static_cast<std::size_t>(iAge_)] = static_cast<float>(std::clamp((t.beat - v.startBeat) / span, 0.0, 1.0));
  v.src[static_cast<std::size_t>(iOff_)] = v.offbeat;
  for (int c = 0; c < nCustom_; ++c)
    if (!std::isnan(v.custom[static_cast<std::size_t>(c)])) v.src[static_cast<std::size_t>(firstCustom_ + c)] = v.custom[static_cast<std::size_t>(c)];

  std::swap(v.vals, v.prevVals);
  std::copy(values, values + v.vals.size(), v.vals.begin());
  applyRoutes(v.src.data(), values, v.vals.data(), false);
  if (v.fresh) { std::copy(v.vals.begin(), v.vals.end(), v.prevVals.begin()); v.fresh = false; }
}

void Modulation::noteOn(ModVoice& v, int note, float vel, const Transport& t, uint64_t serial, bool firstOfPhrase) {
  v.rng.seed(dsp::hashSeed(serial, 0xA11u, static_cast<uint64_t>(note)));
  v.random = v.rng.bipolar();
  v.note = note;
  v.vel = vel;
  v.startBeat = t.beat;
  v.age = 0;
  double nearest = std::round(t.beat);
  v.offbeat = static_cast<float>(std::clamp((t.beat - nearest) * 2.0, -1.0, 1.0));
  v.fresh = true;
  for (auto& c : v.custom) c = NAN;
  const float* values = curValues_;
  if (!values) return;
  for (int l = 0; l < nLfo_; ++l) v.lfo[static_cast<std::size_t>(l)] = LfoRun{};
  for (int s = 0; s < nShape_; ++s) {
    int trig = choiceAt(values, shapeP_[static_cast<std::size_t>(s)].trigger);
    if (trig == TrNote) startShape(v.shape[static_cast<std::size_t>(s)], s, values, t, note, vel);
    else if (trig == TrFirst && firstOfPhrase) startShape(gshape_[static_cast<std::size_t>(s)], s, values, t, note, vel);
  }
}

void Modulation::noteOff(ModVoice& v) {
  for (auto& r : v.shape)
    if (!r.released) { r.released = true; r.relPos = r.pos; }
}

void Modulation::allKeysUp() {
  if (!curValues_) return;
  for (int s = 0; s < nShape_; ++s) {
    auto& r = gshape_[static_cast<std::size_t>(s)];
    if (choiceAt(curValues_, shapeP_[static_cast<std::size_t>(s)].trigger) == TrFirst && !r.released) { r.released = true; r.relPos = r.pos; }
  }
}

void Modulation::trigger(int s, const Transport& t, ModVoice* const* voices, int n) {
  if (s < 0 || s >= nShape_ || !curValues_) return;
  startShape(gshape_[static_cast<std::size_t>(s)], s, curValues_, t, 60, 1.f);
  gshape_[static_cast<std::size_t>(s)].active = true;
  for (int i = 0; i < n; ++i)
    startShape(voices[i]->shape[static_cast<std::size_t>(s)], s, curValues_, t, voices[i]->note, voices[i]->vel);
}

void Modulation::setGlobalSource(int c, float value) {
  if (c >= 0 && c < nCustom_) gcustom_[static_cast<std::size_t>(c)] = value;
}
void Modulation::setVoiceSource(ModVoice& v, int c, float value) {
  if (c >= 0 && c < nCustom_) v.custom[static_cast<std::size_t>(c)] = value;
}
float Modulation::voiceSource(const ModVoice& v, int i) const {
  return i >= 0 && i < static_cast<int>(v.src.size()) ? v.src[static_cast<std::size_t>(i)] : 0.f;
}
float Modulation::globalSource(int i) const {
  return i >= 0 && i < static_cast<int>(gsrc_.size()) ? gsrc_[static_cast<std::size_t>(i)] : 0.f;
}
int Modulation::sourceIndex(Src kind, int n) const {
  switch (kind) {
    case Src::Lfo: return n >= 0 && n < nLfo_ ? firstLfo_ + n : -1;
    case Src::Shape: return n >= 0 && n < nShape_ ? firstShape_ + n : -1;
    case Src::Custom: return n >= 0 && n < nCustom_ ? firstCustom_ + n : -1;
    default: return -1;
  }
}

// ---------------------------------------------------------------- meters

void Modulation::publish(const ModVoice* d) {
  int w = 1 - published_.load(std::memory_order_relaxed);
  auto& s = snap_[w];
  const auto& src = d ? d->src : gsrc_;
  std::copy(src.begin(), src.end(), s.src.begin());
  const auto& m = matrix_->read();
  std::fill(modulated_.begin(), modulated_.end(), 0);
  for (const auto& r : m.routes) modulated_[static_cast<std::size_t>(r.dst)] = 1;
  const auto& vals = d ? d->vals : gvals_;
  for (std::size_t i = 0; i < s.params.size(); ++i) s.params[i] = modulated_[i] ? vals[i] : NAN;
  for (int k = 0; k < nShape_; ++k) {
    bool pv = srcVoice_.empty() ? false : srcVoice_[static_cast<std::size_t>(firstShape_ + k)];
    const ShapeRun& r = pv && d ? d->shape[static_cast<std::size_t>(k)] : gshape_[static_cast<std::size_t>(k)];
    s.shapes[static_cast<std::size_t>(k) * 2] = r.started ? r.phase : -1.f;
    s.shapes[static_cast<std::size_t>(k) * 2 + 1] = r.out;
  }
  published_.store(w, std::memory_order_release);
}

void Modulation::readMeters(float* sources, float* params, float* shapes) const {
  const auto& s = snap_[published_.load(std::memory_order_acquire)];
  if (sources) std::copy(s.src.begin(), s.src.end(), sources);
  if (params) std::copy(s.params.begin(), s.params.end(), params);
  if (shapes) std::copy(s.shapes.begin(), s.shapes.end(), shapes);
}

// ---------------------------------------------------------------- patch data

Json Modulation::saveMatrix() const {
  Json a = Json::array();
  for (const auto& r : matrix_->read().routes) {
    Json j = Json::object();
    j["src"] = sources_[static_cast<std::size_t>(r.src)].desc.id;
    j["dst"] = store_->spec(r.dst).id;
    j["amt"] = r.amt;
    if (r.via >= 0) j["via"] = sources_[static_cast<std::size_t>(r.via)].desc.id;
    a.push(j);
  }
  return a;
}

void Modulation::loadMatrix(const Json& j, std::vector<std::string>* warnings) {
  Matrix m;
  auto warn = [&](std::string s) { if (warnings) warnings->push_back(std::move(s)); };
  for (const auto& e : j.items()) {
    Route r;
    r.src = findSource(e["src"].string());
    r.dst = store_->find(e["dst"].string());
    std::string via = e["via"].string();
    r.via = via.empty() ? -1 : findSource(via);
    r.amt = std::clamp(static_cast<float>(e["amt"].number(0)), -1.f, 1.f);
    if (r.src < 0) { warn("unknown mod source '" + e["src"].string() + "' ignored"); continue; }
    if (r.dst < 0 || !store_->spec(r.dst).modulatable) { warn("'" + e["dst"].string() + "' can't be modulated; route ignored"); continue; }
    if (!via.empty() && r.via < 0) { warn("unknown mod source '" + via + "' (via) ignored"); }
    if (static_cast<int>(m.routes.size()) >= modSlots_) { warn("more routes than modSlots (" + std::to_string(modSlots_) + "); extra ignored"); break; }
    m.routes.push_back(r);
  }
  matrix_->write(std::move(m));
}

Json Modulation::saveShapes() const {
  Json a = Json::array();
  for (const auto& curves : bank_->read().shapes) {
    Json s = Json::object();
    Json cs = Json::array();
    for (const auto& c : curves) {
      Json cj = Json::object();
      Json pts = Json::array();
      for (const auto& p : c.pts) {
        Json pj = Json::array();
        pj.push(p.x); pj.push(p.y); pj.push(p.c); pj.push(p.hold ? 1 : 0);
        if (p.handles) { pj.push(p.ox); pj.push(p.oy); pj.push(p.ix); pj.push(p.iy); pj.push(p.corner ? 1 : 0); }
        pts.push(pj);
      }
      cj["points"] = pts;
      if (c.release >= 0) cj["release"] = c.release;
      cs.push(cj);
    }
    s["curves"] = cs;
    a.push(s);
  }
  return a;
}

void Modulation::loadShapes(const Json& j, std::vector<std::string>* warnings) {
  ShapeBank b;
  b.shapes.resize(static_cast<std::size_t>(nShape_));
  for (int s = 0; s < nShape_; ++s) {
    auto& out = b.shapes[static_cast<std::size_t>(s)];
    for (const auto& cj : j[static_cast<std::size_t>(s)]["curves"].items()) {
      if (static_cast<int>(out.size()) >= kMaxCurves) { if (warnings) warnings->push_back("shape " + std::to_string(s + 1) + ": more than 8 curves; extra ignored"); break; }
      ShapeCurve c;
      for (const auto& pj : cj["points"].items()) {
        if (static_cast<int>(c.pts.size()) >= kMaxPoints) break;
        ShapePoint p;
        p.x = std::clamp(static_cast<float>(pj[0].number()), 0.f, 1.f);
        p.y = std::clamp(static_cast<float>(pj[1].number()), 0.f, 1.f);
        p.c = std::clamp(static_cast<float>(pj[2].number()), -1.f, 1.f);
        p.hold = pj[3].number() >= 0.5;
        if (pj.size() >= 8) {
          p.handles = true;
          p.ox = std::clamp(static_cast<float>(pj[4].number()), 0.f, 1.f);
          p.oy = std::clamp(static_cast<float>(pj[5].number()), -2.f, 2.f);
          p.ix = std::clamp(static_cast<float>(pj[6].number()), -1.f, 0.f);
          p.iy = std::clamp(static_cast<float>(pj[7].number()), -2.f, 2.f);
          p.corner = pj[8].number() >= 0.5;
        }
        c.pts.push_back(p);
      }
      std::stable_sort(c.pts.begin(), c.pts.end(), [](const ShapePoint& a, const ShapePoint& b2) { return a.x < b2.x; });
      if (c.pts.empty()) c = defaultCurve();
      if (c.pts.front().x > 0) { ShapePoint p = c.pts.front(); p.x = 0; c.pts.insert(c.pts.begin(), p); }
      if (c.pts.back().x < 1) { ShapePoint p = c.pts.back(); p.x = 1; c.pts.push_back(p); }
      double rel = cj["release"].number(-1);
      c.release = rel >= 0 ? static_cast<float>(std::min(rel, 1.0)) : -1.f;
      out.push_back(std::move(c));
    }
    if (out.empty()) out.push_back(defaultCurve());
  }
  bank_->write(std::move(b));
}

}  // namespace sk::detail
