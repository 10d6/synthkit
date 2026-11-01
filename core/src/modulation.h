// Internal: modulation sources, the matrix, standard LFOs and shapes.
// Owned by the engine core; not part of the public API.
#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "synthkit/custom.h"
#include "synthkit/dsp/rng.h"
#include "synthkit/json.h"
#include "synthkit/modulation.h"
#include "synthkit/params.h"
#include "synthkit/transport.h"

namespace sk {
struct SynthInfo;
namespace detail {

enum class Src : uint8_t {
  Env, Lfo, Shape, Velocity, Key, Random, Aftertouch, ModWheel, Bend, Const,
  BeatPhase, BarPhase, BarBeat, Downbeat, NoteAge, NoteOffbeat, Custom
};

struct SourceInfo {
  ModSourceDesc desc;
  Src kind;
  int index;  // env/lfo/shape/custom number (0-based)
};

// ---- shapes -------------------------------------------------------------------

struct ShapePoint {
  float x = 0, y = 0;
  float c = 0;       // older curves: curvature of the segment that starts here, -1…1
  bool hold = false; // flat (step) segment
  // Handles (offsets from the point). A segment with a handle at either end
  // is a cubic Bezier; otherwise it uses the curvature `c`.
  bool handles = false;
  float ox = 0, oy = 0;  // out handle: shapes the segment after the point
  float ix = 0, iy = 0;  // in handle: shapes the segment before the point
  bool corner = false;   // handles move independently (editor only)
};

struct ShapeCurve {
  std::vector<ShapePoint> pts;
  float release = -1;  // x of the release point, or -1
  float eval(float x) const;
};

struct ShapeBank {
  std::vector<std::vector<ShapeCurve>> shapes;  // [shape][curve]
};

constexpr int kMaxCurves = 8;
constexpr int kMaxPoints = 64;

struct ShapeRun {
  bool active = false;     // passed key/velocity filters
  bool started = false;    // reached its (quantised) start time
  bool released = false;
  double startAt = 0;      // beats (synced) or seconds
  double pos = 0;          // cycles played
  double relPos = 0;       // pos when released
  double relPhase = 0;     // phase reached when released
  float value = 0;         // output before smoothing
  float out = 0;           // smoothed output
  float phase = 0;         // last evaluated phase (for the UI playhead)
};

struct LfoRun {
  double phase = 0;
  double lastPhase = -1;
  float held = 0, next = 0;  // S&H / smooth random
};

// ---- matrix -------------------------------------------------------------------

struct Route {
  int src = -1, dst = -1, via = -1;
  float amt = 0;
};

struct Matrix {
  std::vector<Route> routes;
};

// ---- per-voice state ------------------------------------------------------------

struct ModVoice {
  std::vector<LfoRun> lfo;
  std::vector<ShapeRun> shape;
  std::vector<float> custom;
  std::vector<float> src;            // this block's source values
  std::vector<float> vals, prevVals; // modulated parameter values
  float random = 0;
  float offbeat = 0;
  Beats startBeat = 0;
  double startSeconds = 0;
  double age = 0;                    // seconds since note start
  dsp::Rng rng;
  int note = 60;
  float vel = 0;
  bool fresh = true;
};

struct VoiceIn {
  const float* env;  // value of each standard envelope at block start
  int nEnv;
  float vel;
  int note;
  float aftertouch;
};

class Modulation {
 public:
  // Setup ------------------------------------------------------------------------
  void addKitParams(ParamBuilder& b, const SynthInfo& info);
  void init(const ParamStore& store, const SynthInfo& info, std::vector<ModSourceDesc> custom, AudioEpoch* epoch);
  bool enabled() const { return enabled_; }
  const std::vector<SourceInfo>& sources() const { return sources_; }
  int findSource(const std::string& id) const;
  int pitchParam() const { return pPitch_; }
  int levelParam() const { return pLevel_; }
  int lfoCount() const { return nLfo_; }
  int shapeCount() const { return nShape_; }

  void prepare(double sampleRate, int nParams, const float* values);
  void prepareVoice(ModVoice& v) const;

  // Audio thread -------------------------------------------------------------------
  // Once per control block, before voices: global sources and global values.
  void beginBlock(const float* values, const Transport& t, double seconds, int len,
                  float modwheel, float bend, float aftertouch);
  const float* globalValues() const { return gvals_.data(); }
  const float* prevGlobalValues() const { return gprev_.data(); }
  // Per voice per block: fills v.vals.
  void voiceBlock(ModVoice& v, const VoiceIn& in, const float* values, const Transport& t, int len);
  void noteOn(ModVoice& v, int note, float vel, const Transport& t, uint64_t serial, bool firstOfPhrase);
  void noteOff(ModVoice& v);
  void allKeysUp();  // releases "first note" shapes
  void trigger(int shape, const Transport& t, ModVoice* const* held, int n);
  int sourceIndex(Src kind, int n) const;  // lfo/shape/custom number -> source index
  void setGlobalSource(int customIndex, float v);
  void setVoiceSource(ModVoice& v, int customIndex, float value);
  float voiceSource(const ModVoice& v, int sourceIndex) const;
  float globalSource(int sourceIndex) const;

  // Meters: snapshot written by the audio thread at the end of a block.
  void publish(const ModVoice* display);
  // sources: nSources values; params: nParams (NaN when unmodulated);
  // shapes: 2 per shape (phase, value).
  void readMeters(float* sources, float* params, float* shapes) const;

  // Patch data (not audio thread) ----------------------------------------------------
  Json saveMatrix() const;
  void loadMatrix(const Json& j, std::vector<std::string>* warnings);
  Json saveShapes() const;
  void loadShapes(const Json& j, std::vector<std::string>* warnings);
  int modSlots() const { return modSlots_; }

 private:
  void computeShape(ShapeRun& r, int s, const float* values, const Transport& t, int len);
  void startShape(ShapeRun& r, int s, const float* values, const Transport& t, int note, float vel);
  double shapeLengthBeats(int s, const float* values, const Transport& t) const;
  float lfoValue(LfoRun& r, int shape, double phase, dsp::Rng& rng);
  void applyRoutes(const float* src, const float* values, float* out, bool globalOnly) const;  // uses mutable scratch
  static ShapeCurve defaultCurve();

  const ParamStore* store_ = nullptr;
  bool enabled_ = false;
  int nEnv_ = 0, nLfo_ = 0, nShape_ = 0, nCustom_ = 0, modSlots_ = 0;
  std::vector<SourceInfo> sources_;
  std::vector<char> srcVoice_;  // this block: does source vary per voice?
  int firstLfo_ = 0, firstShape_ = 0, firstCustom_ = 0;
  int iVel_ = 0, iKey_ = 0, iRandom_ = 0, iAT_ = 0, iMW_ = 0, iBend_ = 0, iConst_ = 0;
  int iBeat_ = 0, iBar_ = 0, iBarBeat_ = 0, iDown_ = 0, iAge_ = 0, iOff_ = 0;

  struct LfoP { int shape, rate, sync, division, mode, phase, depth, fade; };
  struct ShapeP { int length, sync, time, trigger, start, loop, rate, offset, depth, smooth, keyLo, keyHi, velLo, velHi, curve; };
  std::vector<LfoP> lfoP_;
  std::vector<ShapeP> shapeP_;
  int pPitch_ = -1, pLevel_ = -1, pAgeSpan_ = -1;
  int pLfos_ = -1;   // sk.lfos: LFOs in use, when the player adds them

  double sr_ = 48000;
  std::vector<float> gsrc_, gvals_, gprev_;
  std::vector<LfoRun> glfo_;
  std::vector<ShapeRun> gshape_;
  std::vector<float> gcustom_;
  dsp::Rng grng_{0x10F0};
  const float* curValues_ = nullptr;
  std::vector<float> off_;
  std::vector<int> touched_;
  std::vector<char> isTouched_;
  std::vector<char> modulated_;  // params any route targets (for meters)

  std::unique_ptr<CustomSlot<Matrix>> matrix_;
  std::unique_ptr<CustomSlot<ShapeBank>> bank_;

  // Meter double buffer.
  struct Snapshot { std::vector<float> src, params, shapes; };
  Snapshot snap_[2];
  std::atomic<int> published_{0};
};

// Divisions offered by LFO and shape length menus.
const std::vector<std::string>& lfoDivisionNames();
const std::vector<std::string>& shapeLengthNames();

}  // namespace detail
}  // namespace sk
