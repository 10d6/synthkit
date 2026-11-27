#include "Processor.h"

#include "Editor.h"

#include <cmath>
#include <cstring>

namespace skplugin {

namespace {

// Strings cross between sk::Json and juce::var as JSON text.
sk::Json toSk(const juce::var& v) {
  sk::Json j;
  sk::Json::tryParse(juce::JSON::toString(v, true).toStdString(), j);
  return j;
}

juce::var toJuce(const sk::Json& j) { return juce::JSON::parse(juce::String::fromUTF8(j.dump(0).c_str())); }

constexpr const char* kStateFormat = "synthkit-plugin-state";

}  // namespace

// ---- Parameter ------------------------------------------------------------------

static juce::AudioProcessorParameterWithIDAttributes attributesFor(const sk::ParamSpec& s) {
  return juce::AudioProcessorParameterWithIDAttributes()
      .withLabel(juce::String::fromUTF8(s.unit.c_str()))
      .withAutomatable(!s.hidden);
}

// Part 1 keeps the synth's own IDs (so a project made before the multi still
// finds its automation); the others are prefixed.
static juce::String partPrefix(int part, const char* sep) { return part > 0 ? "p" + juce::String(part + 1) + sep : juce::String(); }

Parameter::Parameter(sk::ParamStore& store, int index, int part)
    : juce::AudioProcessorParameterWithID(
          juce::ParameterID{partPrefix(part, ".") + juce::String::fromUTF8(store.spec(index).id.c_str()), 1},
          (part > 0 ? "P" + juce::String(part + 1) + " " : juce::String()) + juce::String::fromUTF8(store.spec(index).name.c_str()),
          attributesFor(store.spec(index))),
      store_(store),
      index_(index),
      part_(part) {}

float Parameter::getValue() const { return static_cast<float>(store_.getNorm(index_)); }
void Parameter::setValue(float norm) { store_.setNorm(index_, juce::jlimit(0.f, 1.f, norm)); }
float Parameter::getDefaultValue() const { return static_cast<float>(spec().toNorm(spec().def)); }

juce::String Parameter::getText(float norm, int maxLen) const {
  auto text = juce::String::fromUTF8(spec().format(spec().fromNorm(norm)).c_str());
  return maxLen > 0 ? text.substring(0, maxLen) : text;
}

float Parameter::getValueForText(const juce::String& text) const {
  double v = 0;
  if (spec().parse(text.toStdString(), v)) return static_cast<float>(spec().toNorm(v));
  return getValue();
}

int Parameter::getNumSteps() const {
  const auto& s = spec();
  if (s.type == sk::ParamType::Float) return AudioProcessorParameter::getNumSteps();
  double step = s.step > 0 ? s.step : 1;
  return std::max(2, static_cast<int>(std::lround((s.max - s.min) / step)) + 1);
}

bool Parameter::isDiscrete() const { return spec().type != sk::ParamType::Float; }
bool Parameter::isBoolean() const { return spec().type == sk::ParamType::Toggle; }

juce::StringArray Parameter::getAllValueStrings() const {
  juce::StringArray out;
  for (const auto& c : spec().choices) out.add(juce::String::fromUTF8(c.c_str()));
  return out;
}

// ---- MixParameter -----------------------------------------------------------------

static const char* const kMixIds[] = {"mute", "solo"};
static const char* const kMixNames[] = {"Mute", "Solo"};

MixParameter::MixParameter(int part, Kind kind)
    : juce::AudioProcessorParameterWithID(juce::ParameterID{"mix.p" + juce::String(part + 1) + "." + kMixIds[kind], 1},
                                          "P" + juce::String(part + 1) + " " + kMixNames[kind]),
      part_(part),
      kind_(kind) {
  norm_.store(getDefaultValue());
}

juce::String MixParameter::getText(float norm, int) const { return norm >= 0.5f ? "On" : "Off"; }

float MixParameter::getValueForText(const juce::String& text) const {
  return text.trim().toLowerCase().startsWith("on") || text.getIntValue() > 0 ? 1.f : 0.f;
}

float MixParameter::fromLayout(const sk::PartSettings& s) const {
  return (kind_ == Mute ? s.mute : s.solo) ? 1.f : 0.f;
}

void MixParameter::toLayout(float norm, sk::PartSettings& s) const {
  (kind_ == Mute ? s.mute : s.solo) = norm >= 0.5f;
}

// ---- Processor ------------------------------------------------------------------

Processor::Processor()
    : AudioProcessor(BusesProperties().withOutput("Output", juce::AudioChannelSet::stereo(), true)) {
  owned_ = sk::makeEngine();
  if (owned_->info().features.multi) {
    multi_ = sk::makeMulti();
    owned_.reset();
  }
  const int parts = partCount();
  perPart_ = engine(0).params().size();
  inGesture_ = std::vector<std::atomic<bool>>(static_cast<std::size_t>(perPart_ * parts));
  // Part-major, so a plain synth's list (and part 1 of a multi) is exactly the engine's.
  for (int part = 0; part < parts; ++part) {
    auto& store = engine(part).params();
    for (int i = 0; i < store.size(); ++i) {
      auto* p = new Parameter(store, i, part);
      params_.push_back(p);
      addParameter(p);
    }
  }
  if (multi_) {
    for (int part = 0; part < parts; ++part)
      for (int k = 0; k < MixParameter::kinds; ++k) {
        auto* m = new MixParameter(part, static_cast<MixParameter::Kind>(k));
        mix_.push_back(m);
        addParameter(m);
      }
    mixAgreed_.assign(mix_.size(), 0.f);
  }
  events_.reserve(4096);
  uiState_ = juce::var(new juce::DynamicObject());
  startTimerHz(30);

  // A new instance starts on the Init preset, like the browser page does:
  // presets/init.json, else the first init.json in a category folder.
  int count = 0;
  const sk::EmbeddedPreset* presets = sk::embeddedPresets(count);
  int init = -1;
  for (int i = 0; i < count; ++i) {
    const juce::String path(presets[i].path);
    if (path == "presets/init.json") { init = i; break; }
    if (init < 0 && (path == "init.json" || path.endsWith("/init.json"))) init = i;
  }
  if (init >= 0) {
    sk::Json patch;
    if (sk::Json::tryParse(presets[init].json, patch)) engine(0).loadPatch(patch);
  }
  seedMix();
}

Processor::~Processor() { stopTimer(); }

void Processor::timerCallback() {
  std::vector<bool> seen(params_.size(), false);
  for (int part = 0; part < partCount(); ++part) {
    int index = 0;
    while (engine(part).takeParamChange(index)) {
      if (index < 0 || index >= perPart_) continue;
      const auto k = slot(part, index);
      if (seen[k]) continue;
      seen[k] = true;
      auto* p = params_[k];
      const bool wrap = !inGesture_[k].load();
      if (wrap) p->beginChangeGesture();
      p->sendValueChangedMessageToListeners(p->getValue());
      if (wrap) p->endChangeGesture();
    }
  }
  syncMix();
}

// The host's mute/solo and the layout are two copies of one thing;
// whichever moved since they last agreed wins.
void Processor::syncMix() {
  if (!multi_) return;
  std::lock_guard<std::mutex> g(engineMutex_);
  auto lay = multi_->layout();
  bool fromHost = false;
  for (std::size_t k = 0; k < mix_.size(); ++k) {
    auto* m = mix_[k];
    auto& s = lay.part[static_cast<std::size_t>(m->part())];
    const float host = m->getValue();
    if (std::fabs(host - mixAgreed_[k]) > 1e-6f) {
      m->toLayout(host, s);
      mixAgreed_[k] = host;
      fromHost = true;
    } else {
      const float now = m->fromLayout(s);
      if (std::fabs(now - mixAgreed_[k]) > 1e-4f) {
        m->beginChangeGesture();
        m->setValue(now);
        m->sendValueChangedMessageToListeners(m->getValue());
        m->endChangeGesture();
        mixAgreed_[k] = m->getValue();
      }
    }
  }
  if (fromHost) {
    multi_->setLayout(lay);
    layoutSerial_.fetch_add(1);
  }
}

void Processor::seedMix() {
  if (!multi_) return;
  std::lock_guard<std::mutex> g(engineMutex_);
  const auto& lay = multi_->layout();
  for (std::size_t k = 0; k < mix_.size(); ++k) {
    mix_[k]->setValue(mix_[k]->fromLayout(lay.part[static_cast<std::size_t>(mix_[k]->part())]));
    mixAgreed_[k] = mix_[k]->getValue();
  }
}

const juce::String Processor::getName() const {
  return juce::String::fromUTF8((multi_ ? multi_->info() : owned_->info()).name.c_str());
}

bool Processor::isBusesLayoutSupported(const BusesLayout& layouts) const {
  if (layouts.inputBuses.size() > 0 && !layouts.getMainInputChannelSet().isDisabled()) return false;
  const auto out = layouts.getMainOutputChannelSet();
  return out == juce::AudioChannelSet::stereo() || out == juce::AudioChannelSet::mono();
}

void Processor::prepareToPlay(double sampleRate, int maxBlock) {
  if (multi_) multi_->prepare(sampleRate, std::max(32, maxBlock));
  else owned_->prepare(sampleRate, std::max(32, maxBlock));
}

void Processor::releaseResources() {
  if (multi_) multi_->releaseResources();
  else owned_->releaseResources();
}

void Processor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) {
  juce::ScopedNoDenormals noDenormals;
  const int n = buffer.getNumSamples();
  if (n <= 0) return;

  // Events: the window's keyboard first (at the block start), then the host's.
  events_.clear();
  {
    const auto scope = uiFifo_.read(uiFifo_.getNumReady());
    auto take = [&](int start, int count) {
      for (int k = start; k < start + count; ++k) {
        sk::MidiEvent e;
        if (events_.size() < events_.capacity() && sk::MidiEvent::fromBytes(uiMidi_[static_cast<std::size_t>(k)].data(), 3, 0, e))
          events_.push_back(e);
      }
    };
    take(scope.startIndex1, scope.blockSize1);
    take(scope.startIndex2, scope.blockSize2);
  }
  for (const auto meta : midi) {
    if (events_.size() >= events_.capacity()) break;
    sk::MidiEvent e;
    const int pos = juce::jlimit(0, n - 1, meta.samplePosition);
    if (sk::MidiEvent::fromBytes(meta.data, meta.numBytes, pos, e)) events_.push_back(e);
  }
  midi.clear();

  sk::HostTransport t;
  if (auto* head = getPlayHead()) {
    if (auto pos = head->getPosition()) {
      if (auto bpm = pos->getBpm()) {
        t.valid = true;
        t.source = sk::TempoSource::Daw;
        t.bpm = *bpm;
        t.playing = pos->getIsPlaying();
        if (auto sig = pos->getTimeSignature()) {
          t.timeSigNum = sig->numerator;
          t.timeSigDen = sig->denominator;
        }
        if (auto ppq = pos->getPpqPosition()) t.beat = *ppq;
        else t.playing = false;  // no position to follow: run the kit's own clock
        const double bpb = t.timeSigNum * 4.0 / std::max(1, t.timeSigDen);
        if (auto bar = pos->getPpqPositionOfLastBarStart()) t.barStart = *bar;
        else t.barStart = std::floor(t.beat / bpb + 1e-9) * bpb;
      }
    }
  }

  const int nOut = std::min(2, buffer.getNumChannels());
  float* outs[2] = {buffer.getWritePointer(0), nOut > 1 ? buffer.getWritePointer(1) : nullptr};
  for (int c = nOut; c < buffer.getNumChannels(); ++c) buffer.clear(c, 0, n);
  if (nOut == 0) return;
  if (multi_) multi_->process(outs, nOut, n, events_.data(), static_cast<int>(events_.size()), t);
  else owned_->process(outs, nOut, n, events_.data(), static_cast<int>(events_.size()), t);

  // Meters for the window.
  float peak = peak_.load(std::memory_order_relaxed);
  int sp = scopePos_.load(std::memory_order_relaxed);
  const float* l = outs[0];
  for (int i = 0; i < n; ++i) {
    peak = std::max(peak, std::fabs(l[i]));
    scope_[static_cast<std::size_t>(sp)].store(l[i], std::memory_order_relaxed);
    sp = (sp + 1) % kScopeSize;
  }
  scopePos_.store(sp, std::memory_order_release);
  peak_.store(peak, std::memory_order_relaxed);
  const auto& tr = engine(0).transport();
  beat_.store(tr.beat, std::memory_order_relaxed);
  bpm_.store(tr.bpm, std::memory_order_relaxed);
  playing_.store(tr.playing, std::memory_order_relaxed);
  num_.store(tr.timeSigNum, std::memory_order_relaxed);
  den_.store(tr.timeSigDen, std::memory_order_relaxed);
}

juce::AudioProcessorEditor* Processor::createEditor() { return makeEditor(*this); }

// ---- state ----------------------------------------------------------------------

void Processor::getStateInformation(juce::MemoryBlock& dest) {
  sk::Json state = sk::Json::object();
  state["format"] = kStateFormat;
  {
    std::lock_guard<std::mutex> g(engineMutex_);
    // Version 2 holds a whole multi; a synth without one still writes 1.
    state["version"] = multi_ ? 2 : 1;
    if (multi_) state["multi"] = multi_->save();
    else state["patch"] = owned_->savePatch();
  }
  state["ui"] = toSk(uiState());
  const std::string text = state.dump(2);
  dest.replaceAll(text.data(), text.size());
}

void Processor::setStateInformation(const void* data, int size) {
  if (data == nullptr || size <= 0) return;
  sk::Json state;
  if (!sk::Json::tryParse(std::string(static_cast<const char*>(data), static_cast<std::size_t>(size)), state)) return;
  // Our own wrapper, or a bare patch or multi (e.g. a preset file dropped in by hand).
  const bool wrapped = state.isObject() && state.contains("format") && state["format"].isString() &&
                       state["format"].string() == kStateFormat;
  const bool bareMulti = !wrapped && state.isObject() && state.contains("format") && state["format"].isString() &&
                         state["format"].string() == "sk.multi";
  {
    std::lock_guard<std::mutex> g(engineMutex_);
    if (multi_) {
      if (wrapped && state.contains("multi")) multi_->load(state["multi"]);
      else if (bareMulti) multi_->load(state);
      else {
        // A single patch (version 1, from before the multi): part 1, alone.
        sk::Json one;
        if (sk::Json::tryParse(R"({"format":"sk.multi","version":1,"parts":[{"patch":)" + (wrapped ? state["patch"] : state).dump(0) + "}]}", one))
          multi_->load(one);
      }
    } else if (!bareMulti && !(wrapped && !state.contains("patch"))) {
      owned_->loadPatch(wrapped ? state["patch"] : state);
    }
  }
  setUiState(wrapped && state.contains("ui") ? toJuce(state["ui"]) : juce::var(new juce::DynamicObject()));
  seedMix();
  notifyAllParams();
  layoutSerial_.fetch_add(1);
  stateSerial_.fetch_add(1);
}

juce::var Processor::uiState() const {
  std::lock_guard<std::mutex> g(uiStateMutex_);
  return uiState_;
}

void Processor::setUiState(const juce::var& ui) {
  std::lock_guard<std::mutex> g(uiStateMutex_);
  uiState_ = ui.isObject() ? ui : juce::var(new juce::DynamicObject());
}

// ---- from the window --------------------------------------------------------------

void Processor::setParamFromUi(int part, int index, double value) {
  if (part < 0 || part >= partCount() || index < 0 || index >= perPart_) return;
  auto& store = engine(part).params();
  store.set(index, value);
  const auto k = slot(part, index);
  auto* p = params_[k];
  const bool wrap = !inGesture_[k].load();
  if (wrap) p->beginChangeGesture();
  p->sendValueChangedMessageToListeners(static_cast<float>(store.getNorm(index)));
  if (wrap) p->endChangeGesture();
}

void Processor::gesture(int part, int index, bool starting) {
  if (part < 0 || part >= partCount() || index < 0 || index >= perPart_) return;
  const auto k = slot(part, index);
  auto& flag = inGesture_[k];
  if (flag.exchange(starting) == starting) return;
  if (starting) params_[k]->beginChangeGesture();
  else params_[k]->endChangeGesture();
}

sk::LoadResult Processor::loadPatchFromUi(int part, const sk::Json& patch) {
  sk::LoadResult r;
  if (part < 0 || part >= partCount()) { r.ok = false; r.error = "no such part"; return r; }
  {
    std::lock_guard<std::mutex> g(engineMutex_);
    r = engine(part).loadPatch(patch);
  }
  if (r.ok) notifyAllParams();
  return r;
}

void Processor::setLayoutFromUi(const sk::Json& layout) {
  if (!multi_) return;
  {
    std::lock_guard<std::mutex> g(engineMutex_);
    multi_->setLayoutJson(layout);
  }
  // The host's mute/solo follow on the next tick (syncMix).
}

sk::LoadResult Processor::loadMultiFromUi(const sk::Json& multi) {
  sk::LoadResult r;
  if (!multi_) { r.ok = false; r.error = "this synth has no multi"; return r; }
  {
    std::lock_guard<std::mutex> g(engineMutex_);
    r = multi_->load(multi);
  }
  if (r.ok) { seedMix(); notifyAllParams(); }
  return r;
}

sk::Json Processor::multiJson() {
  std::lock_guard<std::mutex> g(engineMutex_);
  return multi_->save();
}

sk::Json Processor::layoutJson() {
  std::lock_guard<std::mutex> g(engineMutex_);
  return multi_->layoutJson();
}

void Processor::notifyAllParams() {
  for (auto* p : params_) p->sendValueChangedMessageToListeners(p->getValue());
  for (auto* m : mix_) m->sendValueChangedMessageToListeners(m->getValue());
  updateHostDisplay(ChangeDetails().withNonParameterStateChanged(true));
}

void Processor::queueUiMidi(uint8_t status, uint8_t d1, uint8_t d2) {
  const auto scope = uiFifo_.write(1);
  if (scope.blockSize1 > 0) uiMidi_[static_cast<std::size_t>(scope.startIndex1)] = {status, d1, d2};
  else if (scope.blockSize2 > 0) uiMidi_[static_cast<std::size_t>(scope.startIndex2)] = {status, d1, d2};
}

MeterSnapshot Processor::meters() {
  MeterSnapshot m;
  auto stats = multi_ ? multi_->takeStats() : owned_->takeStats();
  m.voices = stats.activeVoices;
  m.limiterDb = stats.limiterReductionDb;
  m.peak = peak_.exchange(0);
  m.beat = beat_.load();
  m.bpm = bpm_.load();
  m.playing = playing_.load();
  m.num = num_.load();
  m.den = den_.load();
  return m;
}

void Processor::readScope(float* dest, int n) const {
  n = std::min(n, kScopeSize);
  const int end = scopePos_.load(std::memory_order_acquire);
  for (int i = 0; i < n; ++i) {
    const int k = ((end - n + i) % kScopeSize + kScopeSize) % kScopeSize;
    dest[i] = scope_[static_cast<std::size_t>(k)].load(std::memory_order_relaxed);
  }
}

}  // namespace skplugin

// JUCE's entry point.
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new skplugin::Processor(); }
