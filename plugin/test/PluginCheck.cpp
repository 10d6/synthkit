// Loads a built VST3 the way a DAW does and checks it against the engine:
//   <name>_plugin_check <path to .vst3> [--quiet]
// - every synth parameter is exposed, with its ID, name and text
// - a factory preset loads as plugin state and saves back unchanged
// - the plugin plays exactly what sk::Engine plays for the same notes,
//   tempo and automation (bit for bit at the same block size)
// - host automation reaches the sound
// - a MIDI controller mapped to a parameter moves it, and the host hears it
// Exit code 0 = all good.
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_events/juce_events.h>
#include <synthkit/engine.h>

#include <cmath>
#include <cstdio>

namespace {

int failures = 0;
void check(bool ok, const juce::String& good, const juce::String& bad) {
  std::printf("  %s  %s\n", ok ? "PASS" : "FAIL", (ok ? good : bad).toRawUTF8());
  if (!ok) ++failures;
}

struct FakeHead : juce::AudioPlayHead {
  double bpm = 128, ppq = 0;
  int64_t samples = 0;
  bool playing = true;
  juce::Optional<PositionInfo> getPosition() const override {
    PositionInfo p;
    p.setTimeInSamples(samples);
    p.setBpm(bpm);
    p.setTimeSignature(TimeSignature{3, 4});
    p.setIsPlaying(playing);
    p.setPpqPosition(ppq);
    p.setPpqPositionOfLastBarStart(std::floor(ppq / 3.0) * 3.0);
    return p;
  }
};

struct Note { int at; uint8_t status, d1, d2; };

// A JUCE host keeps VST3 state as XML holding the plugin's own bytes
// (base64, under IComponent), followed by JUCE's private data.
void setPluginState(juce::AudioPluginInstance& p, const std::string& json) {
  juce::XmlElement x("VST3PluginState");
  juce::MemoryBlock mb(json.data(), json.size());
  x.createNewChildElement("IComponent")->addTextElement(mb.toBase64Encoding());
  juce::MemoryBlock out;
  juce::AudioProcessor::copyXmlToBinary(x, out);
  p.setStateInformation(out.getData(), static_cast<int>(out.getSize()));
}

std::string getPluginState(juce::AudioPluginInstance& p) {
  juce::MemoryBlock mb;
  p.getStateInformation(mb);
  auto xml = juce::AudioProcessor::getXmlFromBinary(mb.getData(), static_cast<int>(mb.getSize()));
  if (!xml) return {};
  juce::MemoryBlock comp;
  if (auto* c = xml->getChildByName("IComponent")) comp.fromBase64Encoding(c->getAllSubText());
  auto text = comp.toString();
  const int priv = text.indexOf("JUCEPrivateData");
  if (priv >= 0) text = text.substring(0, priv);
  // The plugin's JSON ends at its last closing brace; anything after is JUCE's.
  return text.substring(0, text.lastIndexOfChar('}') + 1).toStdString();
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) { std::fprintf(stderr, "usage: %s <plugin.vst3>\n", argv[0]); return 2; }
  juce::ScopedJuceInitialiser_GUI juce;  // message thread for the plugin
  const juce::File bundle = juce::File::getCurrentWorkingDirectory().getChildFile(argv[1]);

  juce::AudioPluginFormatManager formats;
  juce::addDefaultFormatsToManager(formats);
  juce::OwnedArray<juce::PluginDescription> found;
  juce::VST3PluginFormat vst3;
  vst3.findAllTypesForFile(found, bundle.getFullPathName());
  if (found.isEmpty()) { std::printf("  FAIL  no plugin found in %s\n", bundle.getFullPathName().toRawUTF8()); return 1; }
  juce::String err;
  auto plugin = formats.createPluginInstance(*found[0], 48000, 512, err);
  if (!plugin) { std::printf("  FAIL  couldn't load: %s\n", err.toRawUTF8()); return 1; }
  check(found[0]->isInstrument, "loads as an instrument: " + found[0]->name, "doesn't report itself as an instrument");

  auto ref = sk::makeEngine();
  const auto& info = ref->info();
  check(found[0]->name == juce::String::fromUTF8(info.name.c_str()), "name matches synth.json", "name differs from synth.json: " + found[0]->name);

  // Parameters ----------------------------------------------------------------------
  auto& params = plugin->getParameters();
  auto& store = ref->params();
  // The VST3 wrapper adds hidden parameters after ours for MIDI controllers
  // (VST3 has no CC events: that's how hosts send mod wheel and sustain).
  bool idsOk = params.size() >= store.size();
  juce::String firstBad;
  for (int i = 0; idsOk && i < store.size(); ++i) {
    auto* p = dynamic_cast<juce::HostedAudioProcessorParameter*>(params[i]);
    idsOk = p && p->getName(256) == juce::String::fromUTF8(store.spec(i).name.c_str());
    if (!idsOk) firstBad = juce::String(i) + ": " + (p ? p->getParameterID() + " / " + p->getName(256) : "?");
  }
  check(idsOk, juce::String(store.size()) + " parameters, in the engine's order and names",
        "parameter list differs from the engine's at " + firstBad + " (" + juce::String(params.size()) + " vs " + juce::String(store.size()) + ")");
  const int cutoff = store.find("filter.cutoff");
  if (cutoff >= 0) {
    auto* p = params[cutoff];
    const auto norm = static_cast<float>(store.spec(cutoff).toNorm(2000));
    p->setValue(norm);
    check(p->getText(p->getValue(), 64) == "2.00 kHz" || p->getText(p->getValue(), 64) == "2 kHz",
          "host sees formatted values (" + p->getText(p->getValue(), 64) + ")", "cutoff text is " + p->getText(p->getValue(), 64));
  }

  // State ----------------------------------------------------------------------------
  int nPresets = 0;
  const auto* presets = sk::embeddedPresets(nPresets);
  sk::Json preset;
  for (int i = 0; i < nPresets; ++i)
    if (juce::String(presets[i].path).contains("pump") || preset.isNull()) sk::Json::tryParse(presets[i].json, preset);
  {
    setPluginState(*plugin, preset.dump(2));
    sk::Json state;
    sk::Json::tryParse(getPluginState(*plugin), state);
    ref->loadPatch(preset);
    const bool same = state["patch"].dump(0) == ref->savePatch().dump(0);
    check(same && state["format"].string() == "synthkit-plugin-state",
          "preset \"" + juce::String(preset["name"].string()) + "\" loads as plugin state and saves back unchanged",
          "state round trip differs:\n" + juce::String(state["patch"].dump(0)).substring(0, 400));
  }

  // Sound ----------------------------------------------------------------------------
  const double sr = 48000;
  const int block = 512, blocks = 400;   // ~4.3 s
  FakeHead head;
  plugin->setPlayHead(&head);
  plugin->setPlayConfigDetails(0, 2, sr, block);
  plugin->prepareToPlay(sr, block);
  ref->prepare(sr, block);
  std::vector<Note> notes = {{1000, 0x90, 48, 100}, {1300, 0x90, 55, 90}, {9000, 0x90, 60, 110}, {60000, 0x80, 48, 0},
                             {61000, 0x80, 55, 0}, {90000, 0xB0, 1, 100}, {120000, 0x80, 60, 0}, {140000, 0x90, 67, 80},
                             {180000, 0x80, 67, 0}};
  juce::AudioBuffer<float> buf(2, block);
  std::vector<float> a, b(static_cast<std::size_t>(block) * 2);
  double maxDiff = 0, energy = 0;
  bool finite = true;
  std::vector<sk::MidiEvent> evs;
  for (int k = 0; k < blocks; ++k) {
    const int start = k * block;
    if (k == 200 && cutoff >= 0) {  // automation from the host, mid-render
      const auto norm = static_cast<float>(store.spec(cutoff).toNorm(600));
      params[cutoff]->setValue(norm);
      store.setNorm(cutoff, norm);
    }
    juce::MidiBuffer midi;
    evs.clear();
    for (const auto& n : notes)
      if (n.at >= start && n.at < start + block) {
        const uint8_t bytes[3] = {n.status, n.d1, n.d2};
        midi.addEvent(bytes, 3, n.at - start);
        sk::MidiEvent e;
        if (sk::MidiEvent::fromBytes(bytes, 3, n.at - start, e)) evs.push_back(e);
      }
    buf.clear();
    plugin->processBlock(buf, midi);

    sk::HostTransport t;
    t.valid = true; t.bpm = head.bpm; t.playing = true; t.beat = head.ppq;
    t.timeSigNum = 3; t.timeSigDen = 4; t.barStart = std::floor(head.ppq / 3.0) * 3.0;
    float* outs[2] = {b.data(), b.data() + block};
    ref->process(outs, 2, block, evs.data(), static_cast<int>(evs.size()), t);
    for (int c = 0; c < 2; ++c)
      for (int i = 0; i < block; ++i) {
        const float x = buf.getSample(c, i), y = b[static_cast<std::size_t>(c * block + i)];
        finite = finite && std::isfinite(x);
        maxDiff = std::max(maxDiff, static_cast<double>(std::fabs(x - y)));
        energy += static_cast<double>(x) * x;
      }
    head.ppq += block / sr * head.bpm / 60.0;
    head.samples += block;
  }
  check(finite && energy > 1.0, "plays sound (no NaN/inf)", "silent or non-finite output");
  check(maxDiff == 0, "plays exactly what the engine plays (tempo, notes, mod wheel, automation)",
        "differs from the engine by up to " + juce::String(maxDiff, 8));

  // A MIDI controller mapped to a parameter (ParamDef::cc) moves it, and the
  // host hears about it, as it would from a knob in the window.
  for (int i = 0; i < store.size(); ++i) {
    if (store.spec(i).controllers.empty()) continue;
    const auto c = store.spec(i).controllers[0];
    struct Heard : juce::AudioProcessorParameter::Listener {
      int count = 0;
      void parameterValueChanged(int, float) override { ++count; }
      void parameterGestureChanged(int, bool) override {}
    } heard;
    params[i]->addListener(&heard);
    const double before = store.spec(i).fromNorm(params[i]->getValue());
    const bool up = std::fabs(before - c.hi) > std::fabs(before - c.lo);
    const uint8_t bytes[3] = {0xB0, static_cast<uint8_t>(c.cc), static_cast<uint8_t>(up ? 127 : 0)};
    juce::MidiBuffer midi;
    midi.addEvent(bytes, 3, 0);
    buf.clear();
    plugin->processBlock(buf, midi);
    juce::MessageManager::getInstance()->runDispatchLoopUntil(400);   // the plugin tells the host from its message thread
    const double now = store.spec(i).fromNorm(params[i]->getValue()), want = up ? c.hi : c.lo;
    params[i]->removeListener(&heard);
    check(heard.count > 0 && std::fabs(now - want) <= std::fabs(want) * 1e-3 + 1e-6,
          "CC " + juce::String(c.cc) + " moves " + juce::String(store.spec(i).id.c_str()) + ", and the host hears it",
          "CC " + juce::String(c.cc) + " gave " + juce::String(now) + " (wanted " + juce::String(want) + "), host told " + juce::String(heard.count) + " times");
    break;
  }

  plugin->releaseResources();
  if (failures) std::printf("FAILED: %d\n", failures);
  else std::printf("OK\n");
  plugin.reset();
  return failures ? 1 : 0;
}
