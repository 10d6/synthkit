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

Parameter::Parameter(sk::ParamStore& store, int index)
    : juce::AudioProcessorParameterWithID(juce::ParameterID{juce::String::fromUTF8(store.spec(index).id.c_str()), 1},
                                          juce::String::fromUTF8(store.spec(index).name.c_str()),
                                          attributesFor(store.spec(index))),
      store_(store),
      index_(index) {}

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

// ---- Processor ------------------------------------------------------------------

Processor::Processor()
    : AudioProcessor(BusesProperties().withOutput("Output", juce::AudioChannelSet::stereo(), true)),
      engine_(sk::makeEngine()) {
  auto& store = engine_->params();
  inGesture_ = std::vector<std::atomic<bool>>(static_cast<std::size_t>(store.size()));
  for (int i = 0; i < store.size(); ++i) {
    auto* p = new Parameter(store, i);
    params_.push_back(p);
    addParameter(p);
  }
  events_.reserve(4096);
  uiState_ = juce::var(new juce::DynamicObject());

  // A new instance starts on the Init preset, like the browser page does.
  int count = 0;
  const sk::EmbeddedPreset* presets = sk::embeddedPresets(count);
  for (int i = 0; i < count; ++i) {
    const juce::String path(presets[i].path);
    if (path == "init.json" || path.endsWith("/init.json")) {
      sk::Json patch;
      if (sk::Json::tryParse(presets[i].json, patch)) engine_->loadPatch(patch);
      break;
    }
  }
}

Processor::~Processor() = default;

const juce::String Processor::getName() const { return juce::String::fromUTF8(engine_->info().name.c_str()); }

bool Processor::isBusesLayoutSupported(const BusesLayout& layouts) const {
  if (layouts.inputBuses.size() > 0 && !layouts.getMainInputChannelSet().isDisabled()) return false;
  const auto out = layouts.getMainOutputChannelSet();
  return out == juce::AudioChannelSet::stereo() || out == juce::AudioChannelSet::mono();
}

void Processor::prepareToPlay(double sampleRate, int maxBlock) {
  engine_->prepare(sampleRate, std::max(32, maxBlock));
}

void Processor::releaseResources() { engine_->releaseResources(); }

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
  engine_->process(outs, nOut, n, events_.data(), static_cast<int>(events_.size()), t);

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
  const auto& tr = engine_->transport();
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
  state["version"] = 1;
  {
    std::lock_guard<std::mutex> g(engineMutex_);
    state["patch"] = engine_->savePatch();
  }
  state["ui"] = toSk(uiState());
  const std::string text = state.dump(2);
  dest.replaceAll(text.data(), text.size());
}

void Processor::setStateInformation(const void* data, int size) {
  if (data == nullptr || size <= 0) return;
  sk::Json state;
  if (!sk::Json::tryParse(std::string(static_cast<const char*>(data), static_cast<std::size_t>(size)), state)) return;
  // Our own wrapper, or a bare patch (e.g. a preset file dropped in by hand).
  const bool wrapped = state.isObject() && state.contains("format") && state["format"].isString() &&
                       state["format"].string() == kStateFormat;
  const sk::Json& patch = wrapped ? state["patch"] : state;
  {
    std::lock_guard<std::mutex> g(engineMutex_);
    engine_->loadPatch(patch);
  }
  setUiState(wrapped && state.contains("ui") ? toJuce(state["ui"]) : juce::var(new juce::DynamicObject()));
  notifyAllParams();
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

void Processor::setParamFromUi(int index, double value) {
  if (index < 0 || index >= static_cast<int>(params_.size())) return;
  auto& store = engine_->params();
  store.set(index, value);
  auto* p = params_[static_cast<std::size_t>(index)];
  const bool wrap = !inGesture_[static_cast<std::size_t>(index)].load();
  if (wrap) p->beginChangeGesture();
  p->sendValueChangedMessageToListeners(static_cast<float>(store.getNorm(index)));
  if (wrap) p->endChangeGesture();
}

void Processor::gesture(int index, bool starting) {
  if (index < 0 || index >= static_cast<int>(params_.size())) return;
  auto& flag = inGesture_[static_cast<std::size_t>(index)];
  if (flag.exchange(starting) == starting) return;
  if (starting) params_[static_cast<std::size_t>(index)]->beginChangeGesture();
  else params_[static_cast<std::size_t>(index)]->endChangeGesture();
}

sk::LoadResult Processor::loadPatchFromUi(const sk::Json& patch) {
  sk::LoadResult r;
  {
    std::lock_guard<std::mutex> g(engineMutex_);
    r = engine_->loadPatch(patch);
  }
  if (r.ok) notifyAllParams();
  return r;
}

void Processor::notifyAllParams() {
  for (auto* p : params_) p->sendValueChangedMessageToListeners(p->getValue());
  updateHostDisplay(ChangeDetails().withNonParameterStateChanged(true));
}

void Processor::queueUiMidi(uint8_t status, uint8_t d1, uint8_t d2) {
  const auto scope = uiFifo_.write(1);
  if (scope.blockSize1 > 0) uiMidi_[static_cast<std::size_t>(scope.startIndex1)] = {status, d1, d2};
  else if (scope.blockSize2 > 0) uiMidi_[static_cast<std::size_t>(scope.startIndex2)] = {status, d1, d2};
}

MeterSnapshot Processor::meters() {
  MeterSnapshot m;
  auto stats = engine_->takeStats();
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
