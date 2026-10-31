#include "Editor.h"

#include "Processor.h"
#include "Settings.h"

#include <juce_gui_extra/juce_gui_extra.h>

#include <cmath>
#include <optional>

#if SK_PLUGIN_HAS_UI
#include "SkPluginUi.h"
#endif

namespace skplugin {

#if SK_PLUGIN_HAS_UI

namespace {

// Messages between the page and the plugin all use one event id; the payload
// is {t: kind, …}, mirroring what the page sends its browser audio worklet.
const juce::Identifier kEvent{"sk"};
const juce::String kSizeKey{"synthkit:plugin:size"};

sk::Json toSk(const juce::var& v) {
  sk::Json j;
  sk::Json::tryParse(juce::JSON::toString(v, true).toStdString(), j);
  return j;
}
sk::Json toSk(const juce::String& text) {
  sk::Json j;
  sk::Json::tryParse(text.toStdString(), j);
  return j;
}
juce::var toJuce(const sk::Json& j) { return juce::JSON::parse(juce::String::fromUTF8(j.dump(0).c_str())); }

juce::var finiteOrNull(float v) { return std::isfinite(v) ? juce::var(v) : juce::var(); }

juce::String wrapperName(juce::AudioProcessor::WrapperType t) {
  switch (t) {
    case juce::AudioProcessor::wrapperType_VST3: return "VST3";
    case juce::AudioProcessor::wrapperType_AudioUnit: return "AU";
    case juce::AudioProcessor::wrapperType_Standalone: return "Standalone";
    default: return "plugin";
  }
}

const char* findPage(int& size) {
  // The build embeds exactly one page (<name>.html).
  for (int i = 0; i < SkPluginUi::namedResourceListSize; ++i) {
    if (juce::String(SkPluginUi::originalFilenames[i]).endsWithIgnoreCase(".html"))
      return SkPluginUi::getNamedResource(SkPluginUi::namedResourceList[i], size);
  }
  size = 0;
  return nullptr;
}

}  // namespace

class WebEditor : public juce::AudioProcessorEditor, private juce::Timer {
 public:
  explicit WebEditor(Processor& p)
      : AudioProcessorEditor(p),
        proc_(p),
        settings_(Settings::forSynth(juce::String::fromUTF8(p.engine().info().id.c_str()))),
        web_(options()) {
    addAndMakeVisible(web_);
    // Changes after this point reach the page through the timer. (The page is
    // served a moment later with the state as it is then; a change in between
    // is sent twice, which is harmless.)
    for (auto* prm : proc_.params()) lastValues_.push_back(proc_.engine().params().get(prm->index()));
    lastGeneration_ = proc_.engine().params().generation();
    lastSerial_ = proc_.stateSerial();
    settingsToken_ = settings_->addListener(
        [this](const juce::String& key, const juce::var& value) { send(obj({{"t", "store"}, {"key", key}, {"value", value}})); },
        this);

    int w = 1240, h = 820;
    auto size = settings_->get(kSizeKey);
    if (size.isArray() && size.size() == 2) {
      w = juce::jlimit(560, 4000, static_cast<int>(size[0]));
      h = juce::jlimit(400, 3000, static_cast<int>(size[1]));
    }
    setResizable(true, true);
    setResizeLimits(560, 400, 4000, 3000);
    setSize(w, h);

    web_.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
    startTimerHz(30);
  }

  ~WebEditor() override {
    settings_->removeListener(settingsToken_);
    for (std::size_t i = 0; i < proc_.params().size(); ++i) proc_.gesture(static_cast<int>(i), false);
  }

  void resized() override {
    web_.setBounds(getLocalBounds());
    sizeChangedAt_ = juce::Time::getMillisecondCounter();
  }

 private:
  using Props = std::initializer_list<std::pair<const char*, juce::var>>;
  static juce::var obj(Props props) {
    auto* o = new juce::DynamicObject();
    for (auto& [k, v] : props) o->setProperty(k, v);
    return juce::var(o);
  }

  juce::WebBrowserComponent::Options options() {
    using O = juce::WebBrowserComponent::Options;
    auto dataDir = settings_->file().getParentDirectory();
    return O{}
        .withBackend(O::Backend::webview2)
        .withWinWebView2Options(O::WinWebView2{}
                                    .withUserDataFolder(dataDir.getChildFile("webview2"))
                                    .withBackgroundColour(juce::Colour(0xffdcdfd9))
                                    .withStatusBarDisabled())
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withEventListener(kEvent, [this](const juce::var& m) { receive(m); })
        .withResourceProvider([this](const juce::String& url) { return resource(url); });
  }

  // The page, with the plugin's current state and settings injected so it
  // starts up showing this instance's sound.
  std::optional<juce::WebBrowserComponent::Resource> resource(const juce::String& url) {
    if (url != "/" && url != "/index.html") return std::nullopt;
    int size = 0;
    const char* page = findPage(size);
    if (page == nullptr) return std::nullopt;

    sk::Json patch;
    {
      std::lock_guard<std::mutex> g(proc_.engineLock());
      patch = proc_.engine().savePatch();
    }
    auto host = obj({{"format", wrapperName(proc_.wrapperType)},
                     {"host", juce::PluginHostType().getHostDescription()},
                     {"state", obj({{"patch", toJuce(patch)}, {"ui", proc_.uiState()}})},
                     {"store", settings_->all()}});
    // ASCII only, like the rest of the page (see web/pack.py).
    auto json = juce::JSON::toString(host, juce::JSON::FormatOptions{}
                                               .withSpacing(juce::JSON::Spacing::none)
                                               .withEncoding(juce::JSON::Encoding::ascii))
                    .replace("</", "<\\/");
    auto inject = "<script>window.__skHost = " + json + ";</script>\n";
    auto html = juce::String::fromUTF8(page, size);
    const int at = html.indexOf("<body>");
    html = at >= 0 ? html.substring(0, at + 6) + "\n" + inject + html.substring(at + 6) : inject + html;

    juce::WebBrowserComponent::Resource r;
    auto utf8 = html.toUTF8();
    const auto bytes = std::strlen(utf8.getAddress());
    r.data.resize(bytes);
    std::memcpy(r.data.data(), utf8.getAddress(), bytes);
    r.mimeType = "text/html; charset=utf-8";
    return r;
  }

  void send(const juce::var& msg) { web_.emitEventIfBrowserIsVisible(kEvent, msg); }

  // From the page ---------------------------------------------------------------
  void receive(const juce::var& m) {
    const auto t = m["t"].toString();
    auto& engine = proc_.engine();
    if (t == "midi") {
      const auto& d = m["d"];
      if (d.isArray() && d.size() >= 1)
        proc_.queueUiMidi(static_cast<uint8_t>(static_cast<int>(d[0])), static_cast<uint8_t>(d.size() > 1 ? static_cast<int>(d[1]) : 0),
                          static_cast<uint8_t>(d.size() > 2 ? static_cast<int>(d[2]) : 0));
    } else if (t == "param") {
      const int i = m["i"];
      proc_.setParamFromUi(i, static_cast<double>(m["v"]));
      if (i >= 0 && i < static_cast<int>(lastValues_.size())) lastValues_[static_cast<std::size_t>(i)] = engine.params().get(i);
    } else if (t == "gesture") {
      proc_.gesture(m["i"], static_cast<bool>(m["on"]));
    } else if (t == "patch") {
      auto r = proc_.loadPatchFromUi(toSk(m["json"].toString()));
      if (!r.ok) send(obj({{"t", "log"}, {"msg", juce::String::fromUTF8(r.error.c_str())}}));
      resyncBaseline();
    } else if (t == "custom") {
      std::lock_guard<std::mutex> g(proc_.engineLock());
      engine.setCustomState(m["id"].toString().toStdString(), toSk(m["json"].toString()));
    } else if (t == "mod") {
      std::lock_guard<std::mutex> g(proc_.engineLock());
      engine.setModMatrix(toSk(m["json"].toString()));
    } else if (t == "shapes") {
      std::lock_guard<std::mutex> g(proc_.engineLock());
      engine.setShapes(toSk(m["json"].toString()));
    } else if (t == "panic") {
      engine.panic();
    } else if (t == "allOff") {
      engine.allNotesOff();
    } else if (t == "store") {
      settings_->set(m["key"].toString(), m["value"], this);
    } else if (t == "meta") {
      proc_.setUiState(m["ui"]);
    } else if (t == "export") {
      exportPreset(m["name"].toString(), m["json"].toString());
    } else if (t == "import") {
      importPreset();
    }
  }

  void resyncBaseline() {
    for (std::size_t i = 0; i < lastValues_.size(); ++i) lastValues_[i] = proc_.engine().params().get(static_cast<int>(i));
    lastGeneration_ = proc_.engine().params().generation();
  }

  // Files ------------------------------------------------------------------------
  void exportPreset(const juce::String& name, const juce::String& json) {
    auto safe = juce::File::createLegalFileName(name.isEmpty() ? juce::String("patch") : name);
    chooser_ = std::make_unique<juce::FileChooser>("Export preset", lastDir().getChildFile(safe + ".json"), "*.json");
    chooser_->launchAsync(juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles |
                              juce::FileBrowserComponent::warnAboutOverwriting,
                          [this, json](const juce::FileChooser& fc) {
                            auto f = fc.getResult();
                            if (f == juce::File()) return;
                            if (!f.hasFileExtension("json")) f = f.withFileExtension("json");
                            settings_->set("synthkit:plugin:lastDir", f.getParentDirectory().getFullPathName(), nullptr);
                            const bool ok = f.replaceWithText(json + "\n");
                            send(obj({{"t", "log"}, {"msg", ok ? "Saved " + f.getFileName() : "Couldn't write " + f.getFullPathName()},
                                      {"kind", ok ? "info" : "error"}}));
                          });
  }

  void importPreset() {
    chooser_ = std::make_unique<juce::FileChooser>("Import preset", lastDir(), "*.json");
    chooser_->launchAsync(juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
                          [this](const juce::FileChooser& fc) {
                            auto f = fc.getResult();
                            if (!f.existsAsFile()) return;
                            settings_->set("synthkit:plugin:lastDir", f.getParentDirectory().getFullPathName(), nullptr);
                            send(obj({{"t", "imported"}, {"file", f.getFileName()}, {"text", f.loadFileAsString()}}));
                          });
  }

  juce::File lastDir() const {
    juce::File d(settings_->get("synthkit:plugin:lastDir").toString());
    return d.isDirectory() ? d : juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
  }

  // To the page, 30 times a second ---------------------------------------------------
  void timerCallback() override {
    auto& engine = proc_.engine();
    // The host loaded a project or preset: reload the page's copy.
    if (proc_.stateSerial() != lastSerial_) {
      lastSerial_ = proc_.stateSerial();
      sk::Json patch;
      {
        std::lock_guard<std::mutex> g(proc_.engineLock());
        patch = engine.savePatch();
      }
      send(obj({{"t", "state"}, {"patch", toJuce(patch)}, {"ui", proc_.uiState()}}));
      resyncBaseline();
    }
    // Automation and host edits.
    if (engine.params().generation() != lastGeneration_) {
      lastGeneration_ = engine.params().generation();
      juce::Array<juce::var> changes;
      for (std::size_t i = 0; i < lastValues_.size(); ++i) {
        const float v = engine.params().get(static_cast<int>(i));
        if (v != lastValues_[i]) {
          lastValues_[i] = v;
          changes.add(juce::Array<juce::var>{static_cast<int>(i), v});
        }
      }
      if (!changes.isEmpty()) send(obj({{"t", "params"}, {"changes", changes}}));
    }
    sendMeters();

    // Remember the window size once resizing settles.
    if (sizeChangedAt_ && juce::Time::getMillisecondCounter() - sizeChangedAt_ > 600) {
      sizeChangedAt_ = 0;
      settings_->set(kSizeKey, juce::Array<juce::var>{getWidth(), getHeight()}, this);
    }
  }

  void sendMeters() {
    auto& engine = proc_.engine();
    const auto mtr = proc_.meters();
    float scope[Processor::kScopeSize];
    proc_.readScope(scope, Processor::kScopeSize);
    juce::Array<juce::var> sc;
    sc.ensureStorageAllocated(Processor::kScopeSize);
    for (float s : scope) sc.add(std::round(s * 10000.f) / 10000.f);

    const auto nSrc = engine.modSources().size();
    const auto nPar = static_cast<std::size_t>(engine.params().size());
    const auto nShp = static_cast<std::size_t>(engine.shapeCount()) * 2;
    modBuf_.resize(nSrc + nPar + nShp);
    engine.readModMeters(modBuf_.data(), modBuf_.data() + nSrc, modBuf_.data() + nSrc + nPar);
    juce::Array<juce::var> mod;
    mod.ensureStorageAllocated(static_cast<int>(modBuf_.size()));
    for (float v : modBuf_) mod.add(finiteOrNull(v));

    send(obj({{"t", "meter"},
              {"voices", mtr.voices},
              {"limiterDb", mtr.limiterDb},
              {"peak", mtr.peak},
              {"beat", mtr.beat},
              {"playing", mtr.playing},
              {"bpm", mtr.bpm},
              {"num", mtr.num},
              {"den", mtr.den},
              {"scope", sc},
              {"mod", mod}}));
  }

  Processor& proc_;
  std::shared_ptr<Settings> settings_;
  juce::WebBrowserComponent web_;
  std::unique_ptr<juce::FileChooser> chooser_;
  int settingsToken_ = 0;
  std::vector<float> lastValues_;
  std::vector<float> modBuf_;
  uint32_t lastGeneration_ = 0, lastSerial_ = 0;
  juce::uint32 sizeChangedAt_ = 0;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(WebEditor)
};

juce::AudioProcessorEditor* makeEditor(Processor& p) { return new WebEditor(p); }

#else

juce::AudioProcessorEditor* makeEditor(Processor& p) { return new juce::GenericAudioProcessorEditor(p); }

#endif

}  // namespace skplugin
